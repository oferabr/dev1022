const { promisify } = require('util');

const execPromise = promisify(require('child_process').exec);

const BlameData = require('../models/blameData');
const { errorCodes } = require('../conf/config');

/**
 * Parser for git blame
 *
 * this.cwd: String - current working directory, e.g: 'clones/yehuda/livnoni/try-bridgecrew-terragoat' or tmp/yehuda/livnoni/try-bridgecrew-terragoat
 * this.filePath: String - path of the file, e.g: '/terraform/s3.tf'
 * this.lines: Array of Numbers - 0 index: start lime, 1 index: end line, e,g: [3,9]
 * this.errorLines: Array of Numbers - each number is the line of the error, e.g: [4,6,19]
 */
class GitBlameParser {
    constructor({ cwd, filePath, lines, errorLines, customerName, cache, gitBlameOutputLines }) {
        this.cwd = cwd;
        this.filePath = filePath;
        this.lines = lines;
        this.errorLines = errorLines;
        this.startLine = null;
        this.endLine = null;
        this.blames = [];
        this.customerName = customerName;
        this.cache = cache;
        this.gitBlameOutputLines = gitBlameOutputLines;
        if (this.gitBlameOutputLines[this.gitBlameOutputLines.length - 1] === '') {
            console.log('[GitBlameParser][constructor] - last blame line is empty');
            this.gitBlameOutputLines.pop();
        }
    }

    /**
     * Algorithm to calc the relevant lines of the blame author
     * @private
     */
    _calculateBlameLines() {
        if (!this.errorLines || this.errorLines.length === 0) {
            [this.startLine, this.endLine] = this.lines;
            return;
        }
        // search for error line that is on the range of the resource lines:
        const errorLine = this.errorLines.find(el => el >= this.lines[0] && el <= this.lines[1]);
        this.startLine = errorLine;
        this.endLine = errorLine;
    }

    _getCacheKey() {
        const noSpacesFilePath = this.filePath.replace(/\s/g, '\\ ');
        return `${this.customerName}-${this.startLine}-${this.endLine}-${noSpacesFilePath}`;
    }

    /**
     * read the output of git blame (from file path)
     * for each line create BlameData instance
     * @private
     */
    async _parse() {
        if (!Array.isArray(this.gitBlameOutputLines) || this.gitBlameOutputLines.length === 0) {
            console.error('[GitBlameParser][_parse] - Git blame output is empty');
            const error = new Error('Git blame output is empty');
            error.statusCode = errorCodes.emptyGitBlame;
            throw error;
        }
        const startLine = this.startLine === 0 ? this.startLine : this.startLine - 1;
        const endLine = this.startLine === 0 && this.endLine === 0 ? 1 : this.endLine;
        if (startLine > this.gitBlameOutputLines.length) {
            console.error('[GitBlameParser][_parse] - Trying to access unknown lines');
            const error = new Error('Trying to access unknown lines');
            error.statusCode = errorCodes.unknownLines;
            throw error;
        }
        const relevantLines = this.gitBlameOutputLines.slice(startLine, endLine);
        for (let line of relevantLines) {
            if (!line) return;
            line = line.replace(/\s\s+/g, ' '); // set space for all the line
            const commitHash = line.split(' ')[0].replace(/\W/g, ''); // removing non-alphanumeric chars

            const firstBracketIndex = line.indexOf('(');
            const lastBracketIndex = line.lastIndexOf(')');
            const stringBetweenBracket = line.substring(firstBracketIndex + 1, lastBracketIndex);
            const values = stringBetweenBracket.split(' ');

            let author = values[0];
            let timestampString;
            for (let i = 1; i < values.length; i++) {
                const value = values[i];
                if (Number(value)) {
                    // this is timestamp:
                    timestampString = `${value}000`; // adding 3 digit for JS new Date format
                    break;
                } else {
                    author += ` ${value}`;
                }
            }
            const blameData = new BlameData({ author: author.trim(), commitHash: commitHash.trim(), date: new Date(Number(timestampString)) });
            this.blames.push(blameData);
        }
    }

    /**
     * execute the git blame command and return file as string
     * @param repoPath
     * @param filePath
     * @returns {Promise<string|*>}
     */
    static async executeGitBlameForFile(repoPath, filePath) {
        const noSpacesFilePath = filePath.replace(/\s/g, '\\ ');
        const command = `git blame -t ${noSpacesFilePath}`;// > ${outputFileName}`; // -L means the line range, -t means date as timestamp
        // for DEBUG unmark this:
        // console.info(`execute: ${command}`);
        try {
            const { stdout } = await execPromise(command, { encoding: 'utf8', stdio: 'inherit', cwd: repoPath });
            // for DEBUG unmark this:
            // console.log('stdout', stdout);
            return stdout;
        } catch (e) {
            console.error(`got error while execute: ${command} cwd: ${repoPath}, error: ${e}`);
            e.statusCode = errorCodes.runGitBlame;
            throw e;
        }
    }

    async getBlameData() {
        try {
            this._calculateBlameLines();

            if (this.startLine == null || this.endLine == null) {
                console.error(`can't calculate without startLine and end line, this.lines: ${this.lines}, this.errorLines: ${this.errorLines}`);
                return null;
            }
            const cacheKey = this._getCacheKey();
            if (this.cache[cacheKey]) {
                // for DEBUG un mark this:
                // console.info(`returned from cache: ${cacheKey}`);
                return this.cache[cacheKey];
            }

            await this._parse();
            if (this.blames.length === 0) {
                const objectForPrint = { ...this };
                if (objectForPrint.gitBlameOutputLines) {
                    delete objectForPrint.gitBlameOutputLines;
                    objectForPrint.gitBlameOutputLinesLength = this.gitBlameOutputLines?.length;
                }
                console.info('[GitBlameParser][getBlameData] - no git blames found', JSON.stringify(objectForPrint));
                return null;
            }
            const latestBlameData = this.blames.reduce((a, b) => a.date > b.date ? a : b); // get the latest blame
            if (!this.cache[cacheKey]) this.cache[cacheKey] = latestBlameData;
            return latestBlameData;
        } catch (e) {
            console.error('parser got error: ', e);
            const objectForPrint = { ...this };
            if (objectForPrint.gitBlameOutputLines) {
                delete objectForPrint.gitBlameOutputLines;
                objectForPrint.gitBlameOutputLinesLength = this.gitBlameOutputLines?.length;
            }
            console.info('instance data is:\n', JSON.stringify(objectForPrint)); // this for debugging errors
            throw e;
        }
    }
}

module.exports = GitBlameParser;
