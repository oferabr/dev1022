const { execSync } = require('child_process');
const axios = require('axios');
const { v4 } = require('uuid');
const FormData = require('form-data');
const config = require('../conf/config').apiManager;
const { checkIfFileIsValidForScan, SUPPORTED_SCAN_FILE_EXTENSIONS, SUPPORTED_SCAN_FILE_NAMES } = require('../../../../utils/index');

class ApiManager {
    constructor({ accessToken }) {
        if (!accessToken) throw new Error('can\'t create new ApiManager without access token');

        this.accessToken = accessToken;

        this.axiosInstance = axios.create({
            baseURL: config.baseURL,
            headers: {
                Authorization: `Bearer ${this.accessToken}`
            }
        });
    }

    static _handleBitBucketExceptions(error) {
        if (!error) return;
        const { response } = error;
        if (!response) return;
        const { status, statusText, data } = response;
        if (status || statusText || data) {
            console.error('got error from BitBucket API:\n'
                + `status: ${status}\n`
                + `statusText: ${statusText}\n`
                + `data: ${data ? JSON.stringify(data) : null}`);
        }
    }

    async _doRequest({ method, url, data, params, print = true, headers, blockPagination = false }) {
        const fullPath = `${this.axiosInstance.defaults.baseURL}/${url || ''}`;
        if (print) console.info(`[http request] - ${method ? method.toUpperCase() : ''} ${fullPath} ${data ? JSON.stringify(data) : ''}`);
        try {
            const httpResponse = await this.axiosInstance.request({
                url,
                method,
                data,
                params,
                headers
            });
            const responseData = httpResponse.data;
            if (blockPagination) return responseData;
            let { next, values, page } = responseData;
            if (!next) return responseData.values ? responseData.values : responseData;
            console.info(`got more files then: ${responseData.pagelen} - starting pagination`);
            const paramsWithoutPagelen = { ...params };
            delete paramsWithoutPagelen.pagelen;
            while (next && values.length < config.MAX_FILES) {
                console.info(`pagination - getting the ${page + 1} page, total value length: ${values.length} next url: ${next}`);
                const nextSplitArr = next.split('q=path'); // BB issue - duplicating the full url in the next param on each pagination request
                const bulkResponse = await this.axiosInstance.request({
                    url: nextSplitArr.length < 3 ? next : `${nextSplitArr[0]}q=path${nextSplitArr[nextSplitArr.length - 1]}`,
                    method,
                    params: paramsWithoutPagelen,
                    headers
                });
                values = values.concat(bulkResponse.data.values);
                next = bulkResponse.data.next;
                page = bulkResponse.data.page;
            }
            return values;
        } catch (e) {
            ApiManager._handleBitBucketExceptions(e);
            console.error(`got error while do request for url: ${fullPath} error: ${e}`);
            throw e;
        }
    }

    async getRepository({ workspace, repositoryName }) {
        return this._doRequest({
            method: 'get',
            url: `repositories/${workspace}/${repositoryName}`
        });
    }

    async getRepositories({ workspace }) {
        const repositoriesResponse = await this._doRequest({
            method: 'get',
            url: `repositories/${workspace}`,
            params: {
                pagelen: config.MAX_PAGE_LENGTH
            }
        });
        return repositoriesResponse;
    }

    async getUser() {
        const userResponse = await this._doRequest({
            method: 'get',
            url: 'user'
        });
        return userResponse;
    }

    async getFiles({ workspace, repositoryName, nodeHash = '' }) {
        const filesResponse = await this._doRequest({
            method: 'get',
            url: `repositories/${workspace}/${repositoryName}/src/${nodeHash}/`, // the last '/' means empty path === scan all the repository
            params: {
                max_depth: config.MAX_RECURSIVE_DEPTH,
                pagelen: config.MAX_PAGE_LENGTH,
                q: SUPPORTED_SCAN_FILE_EXTENSIONS.map(type => `path~".${type}"`).concat(SUPPORTED_SCAN_FILE_NAMES.map(fileName => `path~"${fileName}"`)).join(' OR ')
            }
        });
        return filesResponse.filter(file => checkIfFileIsValidForScan(file.path));
    }

    async getLatestBranchReference({ workspace, repositoryName, branchName }) {
        const branchResponse = await this._doRequest({
            method: 'get',
            url: `repositories/${workspace}/${repositoryName}/refs`,
            params: {
                q: `name="${branchName}"`
            }
        });
        if (branchResponse.length === 0) {
            console.warn(`no branch name: ${branchName} exist for repository: ${repositoryName} - workspace: ${workspace}`);
            return null;
        }
        return branchResponse[0].target.hash;
    }

    async getFileContent({ workspace, repositoryName, nodeHash, filePath }) {
        const fileContent = await this._doRequest({
            method: 'get',
            url: `repositories/${workspace}/${repositoryName}/src/${nodeHash}/${filePath}`,
            print: false,
            blockPagination: true
        });
        if (typeof fileContent === 'object') return JSON.stringify(fileContent, null, '\t');
        return fileContent;
    }

    async getWorkspaces() {
        const workspacesResponse = await this._doRequest({
            method: 'get',
            url: 'workspaces',
            params: {
                pagelen: config.MAX_PAGE_LENGTH
            }
        });
        return workspacesResponse;
    }

    async getUserRepositoriesList() {
        const workspacesResponse = await this._doRequest({
            method: 'get',
            url: 'user/permissions/repositories',
            params: {
                pagelen: config.MAX_PAGE_LENGTH,
                q: 'permission>"read"'
            }
        });
        return workspacesResponse;
    }

    async _createNewBranch({ workspace, repositoryName, newBranchName, sourceBranchRef }) {
        console.info(`creating new branch (${newBranchName}) of workspace: ${workspace} with repo name: ${repositoryName} of reference sha: ${sourceBranchRef}`);
        const newBranchResponse = await this._doRequest({
            method: 'post',
            url: `repositories/${workspace}/${repositoryName}/refs/branches`,
            data: {
                name: newBranchName,
                target: {
                    hash: sourceBranchRef
                }
            }
        });
        return newBranchResponse;
    }

    async _commitFiles({ workspace, repositoryName, branchName, commitMessage, commitAuthor, files }) {
        console.info(`commit ${files.length} files on branch: ${branchName} - repo: ${workspace}/${repositoryName}`);

        const bodyFormData = new FormData();
        bodyFormData.append('message', commitMessage);
        bodyFormData.append('author', commitAuthor);
        bodyFormData.append('branch', branchName);

        files.forEach(file => {
            const { content } = file;
            bodyFormData.append(file.path, content);
        });

        const newCommitResponse = await this._doRequest({
            method: 'post',
            url: `repositories/${workspace}/${repositoryName}/src`,
            data: bodyFormData,
            headers: bodyFormData.getHeaders()
        });

        return newCommitResponse;
    }

    async _createPullRequest({ workspace, repositoryName, title, fromBranch, toBranch, description, closeSourceBranch = true }) {
        const newBranchResponse = await this._doRequest({
            method: 'post',
            url: `repositories/${workspace}/${repositoryName}/pullrequests`,
            data: {
                title,
                source: {
                    branch: {
                        name: fromBranch // the new branch
                    }
                },
                destination: {
                    branch: {
                        name: toBranch // the exiting branch
                    }
                },
                description,
                close_source_branch: closeSourceBranch
            }
        });
        return newBranchResponse;
    }

    /**
     * @param workspace - String e.g: livnoni
     * @param repositoryName - String e.g: my-repo-name
     * @param sourceBranchName - String e.g: master
     * @param files - Array of objects e.g: {path: 'src/yudaTestFile.tf', content: STRING}
     * @param commitMessage - String e.g: Fix bucket encryption on app-bucket
     * @param commitAuthor - String e.g: 'Yehuda Bridgecrew automatic <yehuda@bridgecrew.com>'
     * @param title - String e.g: [BC] - terraform security bug
     * @param description - String e.g: BridgeCrew has created this PR to tix one or more vulnerable lines in the terraform file
     * @param closeSourceBranch - Boolean e.g: true
     * @param newBranchName - String - not required, if omitted it created by default as bc-fix-UUID
     * @returns reference object of the pull request
     */
    async createPullRequest({ workspace, repositoryName, sourceBranchName, files,
        commitMessage = config.PR.commitDefaultMessage,
        commitAuthor = config.PR.defaultAuthor,
        title = config.PR.defaultTitle,
        description = config.PR.defaultDescription,
        closeSourceBranch = config.PR.defaultCloseSourceBranch,
        newBranchName = `${config.PR.newBranchPrefix}-${v4()}` }) {
        const branchRef = await this.getLatestBranchReference({ workspace, repositoryName, branchName: sourceBranchName });
        if (!branchRef) throw new Error(`can't create new pull request for: ${workspace}/${repositoryName} branch: ${sourceBranchName} because branch reference doe'st exist`);
        await this._createNewBranch({ workspace, repositoryName, newBranchName, sourceBranchRef: branchRef });
        await this._commitFiles({ workspace, repositoryName, branchName: newBranchName, commitMessage, commitAuthor, files });
        const pullRequestObj = await this._createPullRequest({ workspace, repositoryName, title, fromBranch: newBranchName, toBranch: sourceBranchName, description, closeSourceBranch });
        console.info(`successfully created pull request (${pullRequestObj.title}):\n`
            + `id: ${pullRequestObj.id}\n`
            + `type: ${pullRequestObj.type}\n`
            + `state: ${pullRequestObj.state}\n`
            + `description: ${pullRequestObj.description}\n`
            + `closeSourceBranch: ${pullRequestObj.close_source_branch}\n`
            + `author: ${pullRequestObj.author.display_name}\n`
            + `sourceCommit: ${pullRequestObj.source.commit.hash}\n`
            + `destinationCommit: ${pullRequestObj.destination.commit.hash}\n`
            + `from branch: ${pullRequestObj.source.branch.name}\n`
            + `to branch: ${pullRequestObj.destination.branch.name}`);
        return pullRequestObj;
    }

    /**
     * @param workspace - String e.g: livnoni
     * @param repositoryName - String e.g: my-repo-name
     * @param branchName - String e.g: master
     * @param files - Array of objects e.g: {path: 'src/yudaTestFile.tf', content: STRING}
     * @returns commit response
     */
    async commitAndPush({ workspace, repositoryName, branchName, files }) {
        const branchRef = await this.getLatestBranchReference({ workspace, repositoryName, branchName });
        if (!branchRef) throw new Error(`can't commit and push for: ${workspace}/${repositoryName} branch: ${branchName} because branch reference doe'st exist`);
        const commitMessage = files.map(file => file.commitMessage).join('\n');
        const commitRes = await this._commitFiles({ workspace, repositoryName, branchName, commitMessage, commitAuthor: config.PR.defaultAuthor, files });
        console.info(`successfully commit files to ${branchName}`);
        return commitRes;
    }

    async getHooks({ workspace, repositoryName }) {
        const hooksResponse = await this._doRequest({
            method: 'get',
            url: `repositories/${workspace}/${repositoryName}/hooks`,
            params: {
                pagelen: config.MAX_PAGE_LENGTH
            }
        });
        return hooksResponse;
    }

    async setHook({ workspace, repositoryName, description, url, active, events }) {
        const newHookResponse = await this._doRequest({
            method: 'post',
            url: `repositories/${workspace}/${repositoryName}/hooks`,
            data: {
                description, url, active, events
            }
        });
        return newHookResponse;
    }

    async deleteHook({ workspace, repositoryName, id }) {
        const newHookResponse = await this._doRequest({
            method: 'delete',
            url: `repositories/${workspace}/${repositoryName}/hooks/${id}`
        });
        return newHookResponse;
    }

    async getPullRequestDiffStat({ workspace, repositoryName, pullRequestId }) {
        const pullRequestDiffStatResponse = await this._doRequest({
            method: 'get',
            url: `repositories/${workspace}/${repositoryName}/pullrequests/${pullRequestId}/diffstat`,
            params: {
                pagelen: config.MAX_PAGE_LENGTH
            }
        });
        const filteredFiles = pullRequestDiffStatResponse.filter(prDiffObj => prDiffObj?.new?.path && checkIfFileIsValidForScan(prDiffObj.new.path));
        console.info(`filtered ${filteredFiles.length} of ${pullRequestDiffStatResponse.length} pull request files changes`);
        return filteredFiles;
    }

    async createReport({ workspace, repositoryName, commitHash, reportId, status, data, reportParams }) {
        const newReportResponse = await this._doRequest({
            method: 'put',
            url: `repositories/${workspace}/${repositoryName}/commit/${commitHash}/reports/${reportId}`,
            data: {
                result: status, // PASSED,FAILED,PENDING
                details: reportParams.details,
                title: reportParams.title,
                report_type: reportParams.type,
                reporter: reportParams.reporter,
                link: reportParams.link,
                logo_url: reportParams.logoUrl,
                data
            }
        });
        return newReportResponse;
    }

    async setReportAnnotations({ workspace, repositoryName, commitHash, reportId, annotations }) {
        const newReportAnnotationsResponse = await this._doRequest({
            method: 'post',
            url: `repositories/${workspace}/${repositoryName}/commit/${commitHash}/reports/${reportId}/annotations`,
            data: annotations
        });
        return newReportAnnotationsResponse;
    }

    cloneRepo({ fullRepoPath, customerName, reposFolderPath }) {
        const tokenParameter = 'x-token-auth';
        execSync(`git clone --depth 1 https://${tokenParameter}:${this.accessToken}@bitbucket.org/${fullRepoPath}.git ${reposFolderPath}/${customerName}/${fullRepoPath}`, { encoding: 'utf8', stdio: 'inherit' });
    }

    cloneBranch({ fullRepoPath, clonePath, branchName }) {
        const tokenParameter = 'x-token-auth';
        execSync(`git clone --depth 1 --single-branch --branch "${branchName}" https://${tokenParameter}:${this.accessToken}@bitbucket.org/${fullRepoPath}.git ${clonePath}`, { encoding: 'utf8', stdio: 'inherit' });
    }

    async updateBuild({ workspace, repositoryName, commitHash, data }) {
        const buildResponse = await this._doRequest({
            method: 'post',
            url: `repositories/${workspace}/${repositoryName}/commit/${commitHash}/statuses/build`,
            data
        });
        return buildResponse;
    }
}

module.exports = ApiManager;