const fs = require('fs');
const RemoteLambda = require('@bridgecrew/nodeUtils/remoteLambda/invoke');
const path = require('path');
const { execSync } = require('child_process');
const { promiseAllWithRateLimit } = require('@bridgecrew/nodeUtils/common/promiseAllWithRateLimit');
const { v4 } = require('uuid');
const AWS = require('aws-sdk');

const S3 = new AWS.S3({ maxRetries: 5, signatureVersion: 'v4' });
const { SOURCE_TYPES } = require('@bridgecrew/nodeUtils/models/Enums');
const { ViolationsService, GitBlameMetadata } = require('@bridgecrew/dal-layer');
const fastFolderSize = require('fast-folder-size');
const { promisify } = require('util');
const { camelize } = require('@bridgecrew/vcs-utils');

const fastFolderSizeAsync = promisify(fastFolderSize);
const execAsync = promisify(require('child_process').exec);

const internalProcessHandlerLambda = new RemoteLambda(process.env.INTERNAL_PROC_HANDLER_LAMBDA);
const Parser = require('../parser/parser');
const { GitLogParser } = require('../parser/gitLogParser');

const config = require('../conf/config');
/**
 * In order to add more VCS:
 * 1. On the VCS service manager, create function: getGitCloneString.
 * 2. Declare new variable as remoteLambda for the new VCS, e.g: newVcsRemoteLambda.
 * 3. Add the vcs to the SUPPORTED_VCS array
 * 4. Call to: bitbucketRemoteLambda.invoke('getGitCloneString', {}) ot the _gitCloneString function.
 *
 * In order to run this process on non Lambda invoker, add the following var to process.env:
 * NON_LAMBDA_RUN: true
 */

const githubRemoteLambda = new RemoteLambda(process.env.GITHUB_API_LAMBDA);
const bitbucketRemoteLambda = new RemoteLambda(process.env.BITBUCKET_API_LAMBDA);
const gitlabRemoteLambda = new RemoteLambda(process.env.GITLAB_API_LAMBDA);
const azureRemoteLambda = new RemoteLambda(process.env.AZURE_REPOS_API_LAMBDA);
const violationsRemoteLambda = new RemoteLambda(process.env.VIOLATIONS_API_LAMBDA_NAME);
const repositoriesApiLambda = new RemoteLambda(process.env.REPOSITORIES_API_LAMBDA);
const blackList = [].concat(...Object.values(config.blacklist));
const MAX_BUFFER_SIZE = 1024 * 5000;
const GIT_LOG_SINCE = '90.days';
const NO_COMMITS_MESSAGE = 'does not have any commits yet';
const MAX_FILE_SIZE_IN_BYTES = 2147483648;

/* eslint max-classes-per-file: ["error", 2] */
class GetCloneSrtingError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ValidationError';
    }
}

class GitServiceMgr {
    /**
     * Generic Git service manager for all VCS.
     * The class implement all th Git CLI commands.
     * @property {string} this.customerName
     * @property {string}  this.sourceType
     * @property {string[]} this.repositories - ["{owner}/{repoName_1}", "{owner}/{repoName_2}", "{owner}/{repoName_3}"]
     * @property {object} this.fullRepoToGitCloneString: key value of full repo to git clone command, e.g: {'livnoni/terragoat': https://x-access-token:${REPO_ACCESS_TOKEN}@github.com/livnoni/terragoat.git}
     * @property {object} ViolationsService this.violationsService: service for get violation resources and save blame meta data
     */
    constructor() {
        this.customerName = null;
        this.sourceType = null;
        this.repositories = null;
        this.fullRepoToGitCloneString = {};
        this.violationsService = new ViolationsService();
    }

    _filterViolationResources(violationResources = []) {
        return violationResources.filter(violationResource => {
            const filePath = violationResource?.resource?.s3FileKey;
            if (!filePath) {
                console.info(`filePath doesn't exist on resource: ${violationResource.resource} - skipped.`);
                return false;
            }
            if (filePath.includes('.external_modules')) {
                console.info(`file path (${filePath}) includes .external_modules - skipped.`);
                return false;
            }
            if ((!Array.isArray(violationResource?.errorLines) || violationResource.errorLines.length === 0)
                && (!violationResource.resource.metadataLines || (violationResource.resource.metadataLines && !violationResource.resource.metadataLines.length))) {
                console.log('no errorLines and metadataLines for this resource', violationResource.violationId, violationResource.resourceId, violationResource.scannerType);
                return false;
            }
            return true;
        });
    }

    _groupByResourceS3FileKey(violationResources = []) {
        const violationResourceByS3FileKey = violationResources.reduce((groupsMap, violationResource) => {
            const { s3FileKey } = violationResource.resource;
            const manipulatedFileKey = s3FileKey.startsWith('/') ? s3FileKey.substring(1) : s3FileKey;
            if (!groupsMap[manipulatedFileKey]) {
                // eslint-disable-next-line no-param-reassign
                groupsMap[manipulatedFileKey] = [];
            }
            groupsMap[manipulatedFileKey].push(violationResource);
            return groupsMap;
        }, {});
        return { violationResourceByS3FileKey, s3FileKeys: Object.keys(violationResourceByS3FileKey) };
    }

    async fetchGitBlame({ customerName, sourceType, repositories }) {
        this.customerName = customerName;
        this.sourceType = sourceType;
        this.repositories = repositories;

        console.info(`fetchGitBlame was called with: customerName=${this.customerName} sourceType=${this.sourceType} repositories=${JSON.stringify(this.repositories)}`);

        await this._getGitCloneString();

        let reposFolderPath = '/tmp';
        if (process.env.NON_LAMBDA_RUN) {
            if (!fs.existsSync('clones')) fs.mkdirSync('clones');
            reposFolderPath = 'clones';
        }

        for (const repo of this.repositories) {
            const updatedViolationResources = [];
            const { owner, name } = repo;
            const fullRepoName = `${owner}/${name}`;
            console.log(`customer: ${customerName}, full repo name: ${fullRepoName}`);
            if (blackList.includes(fullRepoName)) {
                console.info(`repo: ${fullRepoName} is on the blacklist - weight is more than 512 mb, do nothing`);
                continue;
            }
            console.time('[violationsRemoteLambda][getViolationResourcesGitBlame] invoke');
            const violationResourcesObject = await violationsRemoteLambda.invoke('violation/controller/getViolationResourcesGitBlame', { customerName, fullRepoName }, undefined, { newInvoke: true });
            console.timeEnd('[violationsRemoteLambda][getViolationResourcesGitBlame] invoke');
            let { violationResources } = violationResourcesObject;
            const { key } = violationResourcesObject;
            if (key) {
                console.time('get violationResources from s3 bucket');
                violationResources = await S3.getObject({
                    Bucket: process.env.SCAN_RESULTS_BUCKET,
                    Key: key
                }).promise();
                console.timeEnd('get violationResources from s3 bucket');
                violationResources = JSON.parse(violationResources.Body).violationResources;
            }
            if (!violationResources || violationResources.length === 0) {
                console.info(`no violation resources for repo: ${fullRepoName}`);
                return;
            }

            console.info(`violationResources length is: ${violationResources.length}`);

            const repoPath = `${reposFolderPath}/${customerName}/${fullRepoName}`;

            execSync(`rm -rf ${repoPath}`, { encoding: 'utf8', stdio: 'inherit' });

            violationResources = this._filterViolationResources(violationResources);

            console.info(`violationResources length after filter: ${violationResources.length}`);

            const { violationResourceByS3FileKey, s3FileKeys } = this._groupByResourceS3FileKey(violationResources);

            try {
                console.time(`cloning to path: '${repoPath}'`);
                execSync(`git clone --bare ${this.fullRepoToGitCloneString[fullRepoName]} ${repoPath}`, { encoding: 'utf8', stdio: 'inherit' });
                console.info('successfully cloned.');
                console.timeEnd(`cloning to path: '${repoPath}'`);

                console.time('Blame Calculation');
                await promiseAllWithRateLimit({
                    arr: s3FileKeys,
                    maxConcurrent: 250,
                    callback: async (filePath) => {
                        const blameCache = {};
                        const relevantViolationResources = violationResourceByS3FileKey[filePath];
                        try {
                            const gitBlameOutput = await Parser.executeGitBlameForFile(repoPath, filePath);
                            const gitBlameOutputLines = gitBlameOutput && gitBlameOutput !== '' ? gitBlameOutput.split('\n') : [];
                            await promiseAllWithRateLimit({
                                arr: relevantViolationResources,
                                maxConcurrent: 100,
                                callback: async (violationResource) => {
                                    const parser = new Parser({
                                        cwd: repoPath,
                                        filePath,
                                        lines: violationResource.resource.metadataLines,
                                        errorLines: violationResource.errorLines,
                                        customerName,
                                        cache: blameCache,
                                        gitBlameOutputLines
                                    });
                                    const blameData = await parser.getBlameData();
                                    if (!blameData) {
                                        console.warn('[GitServiceMgr][fetchGitBlame] - There is no blame data for violation resource', violationResource);
                                        return;
                                    }
                                    const gitBlameMetadata = new GitBlameMetadata({
                                        customerName: this.customerName,
                                        author: blameData.author,
                                        commitHash: blameData.commitHash,
                                        date: blameData.date
                                    });

                                    const updatedViolationResource = {
                                        resourceId: `${violationResource.violationId}::${violationResource.sourceId}::${violationResource.resourceId}`,
                                        updatedData: {
                                            gitBlameMetadata
                                        }
                                    };

                                    const { gitBlameMetadataId } = violationResource;

                                    if (gitBlameMetadataId) {
                                        // update exist gitBlameMetadata
                                        // gitBlameMetadata.gitBlameMetadataId = gitBlameMetadataId;
                                        updatedViolationResource.updatedData.gitBlameMetadataId = gitBlameMetadataId;
                                        updatedViolationResource.updatedData.gitBlameMetadata.gitBlameMetadataId = gitBlameMetadataId;
                                    } else {
                                        // create new gitBlameMetadata for violation resource
                                        // do nothing, gitBlameMetadataId will be generated automatically
                                        // console.info(`creating new git blame metadata for resource id: ${violationResource.resourceId} violation id: ${violationResource.violationId} source id: ${violationResource.sourceId}`);
                                    }

                                    updatedViolationResources.push(updatedViolationResource);
                                }
                            });
                        } catch (e) {
                            if ([config.errorCodes.runGitBlame, config.errorCodes.emptyGitBlame, config.errorCodes.unknownLines].includes(e.statusCode)) {
                                console.warn(`got error while calculating git blame for file path: ${filePath} - skipped.`, e);
                                return;
                            }
                            console.error('got error while calculating git blame for file', e);
                            throw e;
                        }
                    }
                });
                console.log(`finished calculating blame data for customer: ${customerName} with full repo name: ${fullRepoName} total violations to updated is: ${updatedViolationResources.length}`);
                console.timeEnd('Blame Calculation');

                const updatedViolationResourcesChunks = this._sliceIntoChunks(updatedViolationResources, parseInt(config.updatedViolationResourcesChunkSize, 10));

                console.log(`Writing update violation resource to s3 - total violations: ${updatedViolationResources.length} chunks: ${updatedViolationResourcesChunks.length} chunk size: ${config.updatedViolationResourcesChunkSize}`);
                await Promise.all(updatedViolationResourcesChunks.map(updatedViolationResourcesChunk => this.updatedViolationResources({ customerName, violationResources: updatedViolationResourcesChunk, fullRepoName })));
            } catch (e) {
                console.error('got error while cloned repo', e);
                throw e;
            } finally {
                execSync(`rm -rf ${repoPath}`, { encoding: 'utf8', stdio: 'inherit' });
            }
        }
    }

    async updatedViolationResources({ customerName, violationResources, fullRepoName }) {
        const s3Path = `updateViolationsResourcesBlameQueue/${v4()}`;

        const expiredDate = new Date();
        expiredDate.setDate(expiredDate.getDate() + 7);
        await S3.putObject({
            Bucket: process.env.SCAN_RESULTS_BUCKET,
            Key: s3Path,
            Body: JSON.stringify({ customerName, resources: violationResources }),
            Expires: expiredDate
        }).promise();

        console.info(`uploaded updateViolationsResources to s3 for customer: ${customerName} with full repo: ${fullRepoName}, path: ${s3Path}`);

        await violationsRemoteLambda.invoke('violation/controller/updateViolationsResources', { reportKey: s3Path, accountId: fullRepoName, violationCounts: violationResources.length }, undefined, { newInvoke: true });
    }

    _sliceIntoChunks(arr, chunkSize) {
        const res = [];
        for (let i = 0; i < arr.length; i += chunkSize) {
            const chunk = arr.slice(i, i + chunkSize);
            res.push(chunk);
        }
        return res;
    }

    async _getGitCloneString() {
        for (const repo of this.repositories) {
            let serviceMgsResponse; // e.g: https://x-access-token:${REPO_ACCESS_TOKEN}@github.com/REPO_OWNER/REPO_NAME.git
            const { owner, name } = repo;
            console.info(`getting git clone string of repo: ${owner}/${name}`);

            switch (this.sourceType) {
                case SOURCE_TYPES.GITLAB:
                    serviceMgsResponse = await gitlabRemoteLambda.invoke('getGitCloneString', { customerName: this.customerName, repoOwner: owner, repoName: name });
                    break;
                case SOURCE_TYPES.BITBUCKET:
                case SOURCE_TYPES.BITBUCKET_ENTERPRISE:
                    serviceMgsResponse = await bitbucketRemoteLambda.invoke(`${this.sourceType === SOURCE_TYPES.BITBUCKET_ENTERPRISE ? 'enterprise/' : ''}getGitCloneString`, { customerName: this.customerName, repoOwner: owner, repoName: name });
                    break;
                case SOURCE_TYPES.GITHUB:
                    serviceMgsResponse = await githubRemoteLambda.invoke('getGitCloneString', { customerName: this.customerName, repoOwner: owner, repoName: name });
                    break;
                case SOURCE_TYPES.AZURE_REPOS:
                    serviceMgsResponse = await azureRemoteLambda.invoke('service/getGitCloneString', { customerName: this.customerName, repoOwner: owner, repoName: name });
                    break;
                case SOURCE_TYPES.GITHUB_ENTERPRISE:
                    serviceMgsResponse = await githubRemoteLambda.invoke('enterprise/getGitCloneString', { customerName: this.customerName, repoOwner: owner, repoName: name });
                    break;
                default:
                    console.info(`source type: ${this.sourceType} doesn't supported for git blame`);
                    return;
            }

            // validate response:
            if (!serviceMgsResponse || !serviceMgsResponse.gitCloneString) {
                const msg = `failed to fetch git clone string: ${JSON.stringify(serviceMgsResponse)}`;
                throw new Error(msg);
            }

            this.fullRepoToGitCloneString[`${owner}/${name}`] = serviceMgsResponse.gitCloneString;
        }
    }

    async getCloneErrorsForScan({ customerName, executionTime, source }) {
        const timestamp = new Date(executionTime).getTime();
        const failedPath = `clones/${customerName}/${timestamp}${source ? `/${source}` : ''}/failedClones/failed_repos_clone.json`;
        const failedRepositories = await this._readLogsDataFromVCSBucket({ Key: failedPath });
        return { failedRepositories, failedRepositoriesCount: failedRepositories.length };
    }

    async calcRepoSize({ repoPath }) {
        const bytes = await fastFolderSizeAsync(repoPath);
        const convertToMBFactor = 1024 * 1024;
        const mb = (bytes / convertToMBFactor);
        console.info(`[gitServiceMgr][calcRepoSize] - the clone size in path: ${repoPath} is ${mb} mb`);
        return mb;
    }

    async _readLogsDataFromVCSBucket({ Key }) {
        try {
            const rawData = await S3.getObject({
                Bucket: process.env.VCS_BUCKET,
                Key
            }).promise();
            return JSON.parse(rawData.Body.toString());
        } catch (err) {
            if (err?.code === 'NoSuchKey') {
                return [];
            }
            console.error(`[GitServiceMgr][_readLogsDataFromVCSBucket] - failed read data to S3 - path ${Key}`, err);
            throw err;
        }
    }

    async _uploadDataToVCSBucket({ Key, data }) {
        try {
            const Expires = new Date();
            Expires.setDate(Expires.getDate() + 7);
            await S3.putObject({
                Bucket: process.env.VCS_BUCKET,
                Key,
                Body: Buffer.from(JSON.stringify(data), 'utf8'),
                Expires
            }).promise();
        } catch (e) {
            console.error(`[GitServiceMgr][uploadDataToVCSBucket] - failed upload data to S3 - path ${path}`, e);
            throw e;
        }
    }

    async _upsertCloneLogData({ Key, newLogs = [] }) {
        if (newLogs.length > 0) {
            const olderLogs = await this._readLogsDataFromVCSBucket({ Key });
            olderLogs.push(...newLogs);
            await this._uploadDataToVCSBucket({ Key, data: olderLogs });
        }
    }

    async writeCloneResults({ customerName, executionTime, source, cloneResults }) {
        const timestamp = new Date(executionTime).getTime();
        const failedClones = cloneResults.filter(cloneData => cloneData.error);
        const successfulClones = cloneResults.filter(cloneData => !!cloneData.cloneSize);
        const failedPath = `clones/${customerName}/${timestamp}${source ? `/${source}` : ''}/failedClones/failed_repos_clone.json`;
        const successPath = `clones/${customerName}/${timestamp}${source ? `/${source}` : ''}/statistics/clone_details.json`;
        console.log(`[gitServiceManager][writeCloneResults] - number of failedClones ${failedClones.length}`);
        console.log(`[gitServiceManager][writeCloneResults] - number of successfulClones ${successfulClones.length}`);
        await Promise.all([
            this._upsertCloneLogData({ Key: failedPath, newLogs: failedClones }),
            this._upsertCloneLogData({ Key: successPath, newLogs: successfulClones })
        ]);
    }

    cleanRepoPathIfExists(reposFolderPath, customerName) {
        const pathToRemove = `${reposFolderPath}/${customerName}`;
        if (fs.existsSync(pathToRemove)) {
            console.info(`[gitServiceManager][cleanRepoPathIfExists]- Removing the content in the path: ${pathToRemove}`);
            execSync(`rm -rf ${pathToRemove}`, { encoding: 'utf8', stdio: 'inherit' });
        } else {
            console.info(`[gitServiceManager][cleanRepoPathIfExists]- Path to remove ${pathToRemove} not exists`);
        }
    }

    async cloneRepository({ customerName, repository, executionTime, fullClone = true, shouldConsiderBlackList = false, branch }) {
        console.log(`[gitServiceManager][cloneRepository]- Cloning ${repository.source} repository ${JSON.stringify(repository)} for customer ${customerName}`);

        let reposFolderPath = '/tmp';

        if (process.env.NON_LAMBDA_RUN) {
            if (!fs.existsSync('repo_clones')) fs.mkdirSync('repo_clones');
            reposFolderPath = 'repo_clones';
        }
        const repoName = repository.repository;
        const { id, owner, source } = repository;

        const fullRepoName = `${owner}/${repoName}`;
        if (shouldConsiderBlackList && blackList.includes(fullRepoName)) {
            console.info(`repo: ${fullRepoName} is on the blacklist, do nothing`);
        }

        let result = {
            repositoryName: fullRepoName,
            repositoryId: id
        };

        try {
            // Get clone string
            const getStringResponse = await internalProcessHandlerLambda.invoke('internal/invokeExternalServiceManager', {
                externalServiceName: camelize(source),
                path: 'getGitCloneString',
                body: { customerName, repoName, repoOwner: owner }
            });

            const cloneString = getStringResponse.data.gitCloneString;
            console.log(`[gitServiceManager][cloneRepository] - This is the clone string for customer ${customerName} and repository ${repository}: ${cloneString}`);

            if (!cloneString || getStringResponse.status === 'failure') {
                const failureMessage = getStringResponse.data.errorMessage || 'gitCloneString returned null';
                console.error(`[gitServiceManager][cloneRepository] - getGitCloneString invocation status: FAILURE [customerName: ${customerName}] [source: ${source}] [repository: ${owner}/${repoName}] [reason: ${failureMessage}]`);

                throw new GetCloneSrtingError(`failure on getGitCloneString - reason: ${failureMessage}`);
            } else {
                console.info(`[gitServiceManager][cloneRepository] - getGitCloneString invocation status: SUCCESS [customerName: ${customerName}] [source: ${source}] [repository: ${owner}/${repoName}]`);
            }

            const repoPath = `"${reposFolderPath}/${customerName}/${fullRepoName}"`;
            const repoPathWithoutQuotes = `${reposFolderPath}/${customerName}/${fullRepoName}`;

            console.info(`[gitServiceManager][cloneRepository]- Removing the content in the path if exists: ${repoPath}`);
            this.cleanRepoPathIfExists(reposFolderPath, customerName);

            const repoFolderPathSize = await this.calcRepoSize({ repoPath: reposFolderPath });
            console.info(`[gitServiceManager][cloneRepository]-This is the /tmp size before cloning repo ${repoName} for customer ${customerName}: ${repoFolderPathSize}`);

            console.info(`[gitServiceManager][cloneRepository]- Cloning to path: ${repoPath}`);
            const startTime = performance.now();
            console.info(`[gitServiceManager][cloneRepository]- Clone startTime for path ${repoPath}: ${startTime}ms`);

            const commandString = `git clone ${cloneString} ${repoPath}`;
            console.log('[gitServiceManager][cloneRepository]- this is the command string: ', commandString);

            execSync(commandString, { encoding: 'utf8' });

            const endTime = performance.now();
            console.info(`[gitServiceManager][cloneRepository]- Clone endTime for path ${repoPath}: ${endTime}ms`);
            console.info(`[gitServiceManager][cloneRepository] - clone status: SUCCESS [customerName: ${customerName}] [source: ${source}] [repository: ${owner}/${repoName}]`);

            const cloneSize = await this.calcRepoSize({ repoPath: repoPathWithoutQuotes });
            const cloneDuration = endTime - startTime;
            console.info(`[gitServiceManager][cloneRepository]- Clone totalTime for path ${repoPath}: ${cloneDuration}ms`);
            console.info(`[gitServiceManager][cloneRepository]- Clone size for path ${repoPath}: ${cloneSize}`);
            console.info(`[gitServiceManager][cloneRepository]- Successfully cloned repo: ${repoName}`);
            console.info(`[gitServiceManager][cloneRepository]- about to update repository statistics: ${repoName}`);
            await this.updateRepositoryStatistics({ repoPath, repositoryId: id });
            result = { ...result, cloneSize, cloneDuration };
        } catch (error) {
            const errorMessage = error.stderr ? error.stderr : JSON.stringify(error, Object.getOwnPropertyNames(error));
            if (error.stderr && error.stderr.includes(config.knownGitCloneErrors.branchIsNotAvailable)) {
                console.error('[gitServiceManager][cloneRepository]- Known git clone error: branch not found');
                // console.info(`git clone full repository: ${fullRepoName}`);
                // execSync(`cd ${repoPath} && git checkout ${commitHash}`, { encoding: 'utf8' });
            } else if (error instanceof (GetCloneSrtingError)) {
                console.info(`[gitServiceManager][cloneRepository] - clone status: SKIPPED [customerName: ${customerName}] [source: ${source}] [repository: ${owner}/${repoName}]`);
            } else {
                console.error(`[gitServiceManager][cloneRepository]- clone status: FAILED [customerName: ${customerName}] [source: ${source}] [repository: ${owner}/${repoName}] [reason: ${errorMessage}]`);
            }

            const failureTime = performance.now();

            result = { ...result, failureTime, error: errorMessage };
        } finally {
            let repoFolderPathSize = await this.calcRepoSize({ repoPath: reposFolderPath });
            console.info(`[gitServiceManager][cloneRepository]-This is the /tmp size after cloning repo ${repoName} for customer ${customerName}: ${repoFolderPathSize}`);

            this.cleanRepoPathIfExists(reposFolderPath, customerName);

            repoFolderPathSize = await this.calcRepoSize({ repoPath: reposFolderPath });
            console.info(`[gitServiceManager][cloneRepository]-This is the /tmp size after cleaning repo ${repoName} for customer ${customerName}: ${repoFolderPathSize}`);
        }

        return result;
    }

    async cloneRepoAndUploadToS3({ customerName, sourceType, repositories, prefix, commitHash }) {
        this.customerName = customerName;
        this.repositories = repositories;
        this.sourceType = SOURCE_TYPES[sourceType];

        console.info(`cloneRepoAndUploadToS3 was called with: customerName=${this.customerName} sourceType=${this.sourceType} repositories=${JSON.stringify(this.repositories)} commitHash: ${commitHash}`);

        await this._getGitCloneString();

        let reposFolderPath = '/tmp';
        if (process.env.NON_LAMBDA_RUN) {
            if (!fs.existsSync('clones')) fs.mkdirSync('clones');
            reposFolderPath = 'clones';
        }
        for (const repo of this.repositories) {
            const { owner, name, branch, fullForkedRepoName } = repo;
            const fullRepoName = `${owner}/${name}`;

            if (blackList.includes(fullRepoName)) {
                console.info(`repo: ${fullRepoName} is on the blacklist - weight is more than 512 mb, do nothing`);
                continue;
            }

            let fullRepoToGitCloneString = this.fullRepoToGitCloneString[fullRepoName];

            if (!fullRepoToGitCloneString) {
                console.info(`fullRepoToGitCloneString doesnt exists, repository: ${fullRepoName}`);
                return;
            }

            console.log(`fullRepoToGitCloneString: ${fullRepoToGitCloneString}`);

            const repoPath = `${reposFolderPath}/${customerName}/${fullRepoName}`;

            this.cleanRepoPathIfExists(reposFolderPath, customerName);

            try {
                console.info(`cloning to path: ${repoPath} ...`);
                if (fullForkedRepoName) {
                    const cloneStringArr = fullRepoToGitCloneString.split(fullRepoName);
                    fullRepoToGitCloneString = `${cloneStringArr[0]}${fullForkedRepoName}${cloneStringArr[1]}`;
                    console.log(`cloning forked branch with fullRepoToGitCloneString: ${fullRepoToGitCloneString}`);
                }
                try {
                    const command = `git clone --depth 1 --single-branch --branch "${branch}" ${fullRepoToGitCloneString} ${repoPath}`;
                    console.log(`[gitServiceManager][cloneRepoAndUploadToS3] - git clone command to execute: ${command}`);
                    execSync(command, { encoding: 'utf8' });
                } catch (error) {
                    if (error.stderr && error.stderr.includes(config.knownGitCloneErrors.branchIsNotAvailable)) {
                        console.warn('known git clone error: branch not found');
                        console.info(`git clone full repository: ${fullRepoName}`);
                        execSync(`git clone ${fullRepoToGitCloneString} ${repoPath}`, { encoding: 'utf8' });
                        execSync(`cd ${repoPath} && git checkout ${commitHash}`, { encoding: 'utf8' });
                    } else {
                        console.error('Error during clone repo: ', error);
                        throw error;
                    }
                }

                console.info('successfully cloned.');
                console.log('uploading repo to s3');
                await this.uploadDir(repoPath, prefix, process.env.SCAN_RESULTS_BUCKET);
            } catch (e) {
                console.error('got error while cloned repo', e);
                throw e;
            } finally {
                this.cleanRepoPathIfExists(reposFolderPath, customerName);
            }
        }

        const scanPaths = this.repositories.map(repo => ({ owner: repo.owner, name: repo.name, path: prefix, public: false, isRepoOnBlackList: blackList.includes(`${repo.owner}/${repo.name}`) }));
        return scanPaths;
    }

    async uploadDir(repoPath, prefix, bucketName) {
        async function getFiles(dir) {
            const dirents = await fs.readdirSync(dir, { withFileTypes: true });
            const files = await Promise.all(
                dirents.map((dirent) => {
                    const res = path.resolve(dir, dirent.name);
                    const fileStat = fs.lstatSync(res);
                    if (fileStat.isSymbolicLink()) return null;
                    return dirent.isDirectory() ? getFiles(res) : res;
                }).filter(x => x)
            );
            return Array.prototype.concat(...files);
        }

        const files = (await getFiles(repoPath));

        const uploads = files.map((filePath) => {
            const { size } = fs.statSync(filePath);
            if (size >= MAX_FILE_SIZE_IN_BYTES) return;
            const bucketPath = filePath.substring(repoPath.length + 1);
            return S3.putObject({
                Key: `${prefix}/${bucketPath}`,
                Bucket: bucketName,
                Body: fs.readFileSync(filePath)
            })
                .promise();
        });
        return Promise.all(uploads);
    }

    async getRelevantResources({ customerName, resources, sourceType, repository, patchLinesToFileMapping }) {
        this.customerName = customerName;
        this.sourceType = sourceType;

        console.info(`getRelevantCICDViolations was called with: customerName=${this.customerName} sourceType=${this.sourceType} repository=${repository} resources=${JSON.stringify(resources)}`);
        let serviceMgsResponse;
        switch (this.sourceType) {
            case SOURCE_TYPES.GITHUB:
                serviceMgsResponse = await githubRemoteLambda.invoke('getRelevantResources', { resources, patchLinesToFileMapping });
                return serviceMgsResponse;
            case SOURCE_TYPES.GITHUB_ENTERPRISE:
                serviceMgsResponse = await githubRemoteLambda.invoke('enterprise/getRelevantResources', { resources, patchLinesToFileMapping });
                return serviceMgsResponse;
            default:
                break;
        }
    }

    async updateRepositoryStatistics({ repoPath, repositoryId }) {
        try {
            const gitLogCommand = `cd ${repoPath} && git log --since=${GIT_LOG_SINCE} --pretty=format:"%ad %ae %an"`;
            console.log(`[gitServiceManager][updateRepositoryStatistics] About to get git log with command ${gitLogCommand}`);
            const response = await execAsync(gitLogCommand, { maxBuffer: MAX_BUFFER_SIZE });
            if (response.stderr) {
                throw new Error(`[gitServiceManager][updateRepositoryStatistics] Failed get git  log for repoId: ${repositoryId} error: ${response.stderr}`);
            }
            const gitLogParser = new GitLogParser();
            const { contributorsData, currentWeekCommits, prevWeekCommits } = gitLogParser.getParsedData(response.stdout);
            await Promise.all([repositoriesApiLambda.invoke('repositoriesService/saveRepositoryContributors', {
                contributorsData,
                repositoryId
            }), repositoriesApiLambda.invoke('repositoriesService/saveRepositoryCommitStats', {
                currentWeekCommits,
                prevWeekCommits,
                repositoryId
            })]);
        } catch (e) {
            console.error('[gitServiceManager][updateRepositoryStatistics] Failed to update repository', e);
            if (e.stderr?.includes(NO_COMMITS_MESSAGE)) {
                return;
            }
            throw new Error(`[gitServiceManager][updateRepositoryStatistics] Failed to update repository statistics for repositoryId: ${repositoryId}`);
        }
    }
}

module.exports = { GitServiceMgr };