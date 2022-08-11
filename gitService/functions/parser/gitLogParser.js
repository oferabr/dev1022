const DAYS_IN_MILLISECONDS = 24 * 60 * 60 * 1000;
const EMAIL_START_INDEX = 6;
const USER_NAME_START_INDEX = 7;

class GitLogParser {
    constructor() {
        this.currentWeekCommits = 0;
        this.prevWeekCommits = 0;
        this.contributorsData = [];
        this.existingContributorsEmails = new Set();
        this.now = new Date();
        this.oneWeekAgo = new Date(this.now.getTime() - (7 * DAYS_IN_MILLISECONDS));
        this.twoWeeksAgo = new Date(this.now.getTime() - (14 * DAYS_IN_MILLISECONDS));
    }

    getParsedData(gitLog) {
        if (gitLog) {
            const logAsArray = gitLog.split('\n');
            console.log(`[GitLogParser][getParsedData] going to parse ${logAsArray.length} git log lines`);
            logAsArray.forEach(gitLogLine => {
                try {
                    const { contributorEmail, contributorUsername, date } = this._processLine(gitLogLine);
                    if (!contributorEmail || !contributorUsername || !date) {
                        console.warn(`[GitLogParser][getParsedData] corrupted line while parsing git log: ${gitLogLine}`);
                        return;
                    }
                    if (!this.existingContributorsEmails.has(contributorEmail)) {
                        this.existingContributorsEmails.add(contributorEmail);
                        this.contributorsData.push({ contributorEmail, contributorUsername });
                    }
                    this._increaseNumberOfRelevantCommits(date);
                } catch (e) {
                    console.warn(`Failed to parse line: ${gitLogLine} will skip line`, e);
                }
            });
        }
        return {
            contributorsData: this.contributorsData,
            currentWeekCommits: this.currentWeekCommits,
            prevWeekCommits: this.prevWeekCommits
        };
    }

    _processLine(gitLogLine) {
        //  Tue May 31 13:11:01 2022 +0300 user@email.com userName
        const infoArr = gitLogLine.split(' ');
        const contributorEmail = infoArr[EMAIL_START_INDEX];
        const contributorUsername = infoArr.slice(USER_NAME_START_INDEX, infoArr.length).join(' ');
        const date = infoArr.slice(0, EMAIL_START_INDEX).join(' ');
        return { contributorEmail, contributorUsername, date };
    }

    _increaseNumberOfRelevantCommits(date) {
        const commitDate = new Date(date);
        if (this._isPrevWeekCommit(commitDate)) {
            this.prevWeekCommits++;
        } else if (this._isCurrentWeekCommit(commitDate)) {
            this.currentWeekCommits++;
        }
    }

    _isCurrentWeekCommit(commitDate) {
        return commitDate >= this.oneWeekAgo;
    }

    _isPrevWeekCommit(commitDate) {
        return (commitDate >= this.twoWeeksAgo && commitDate < this.oneWeekAgo);
    }
}

module.exports = { GitLogParser };
