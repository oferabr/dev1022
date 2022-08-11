const { execSync } = require('child_process');
const axios = require('axios');
const { v4 } = require('uuid');
const FormData = require('form-data');
const https = require('https');
const { checkIfFileIsValidForScan } = require('../../../../utils/index');
const config = require('../conf/config').bitbucketEnterpriseApiManager;
const ipSecCustomers = require('../../../../ipsec-customers.json');

/**
 * documentation for the AP's: https://docs.atlassian.com/bitbucket-server/rest/6.7.0/bitbucket-rest.html#resources
 */
class ApiManager {
    constructor({ accessToken, baseURL, customerName }) {
        if (!accessToken) throw new Error('can\'t create new ApiManager without access token');
        if (!baseURL) throw new Error('can\'t create new ApiManager without baseURL');

        this.accessToken = accessToken;
        this.baseUrl = baseURL;

        const axiosCreateParams = {
            baseURL,
            headers: {
                Authorization: `Bearer ${this.accessToken}`
            }
        };
        if (ipSecCustomers[customerName]) {
            axiosCreateParams.httpsAgent = new https.Agent({
                rejectUnauthorized: false
            });
        }
        this.axiosInstance = axios.create(axiosCreateParams);
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
        const fullPath = `${this.axiosInstance.defaults.baseURL}${url || ''}`;
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
            let { isLastPage, values } = responseData;
            const { nextPageStart, size } = responseData;
            if (!Array.isArray(values)) return responseData;
            if (isLastPage) return responseData.values ? responseData.values : responseData;
            console.info(`got ${size} files - starting pagination`);
            const paginationParams = { ...params };
            paginationParams.start = nextPageStart;
            while (!isLastPage && values.length < config.MAX_FILES) {
                console.info(`pagination - getting the ${size} values, total value length: ${values.length} isLastPage: ${isLastPage}`);
                const bulkResponse = await this.axiosInstance.request({
                    url,
                    method,
                    params: paginationParams,
                    headers
                });
                values = values.concat(bulkResponse.data.values);
                isLastPage = bulkResponse.data.isLastPage;
                paginationParams.start = bulkResponse.data.nextPageStart;
            }
            return values;
        } catch (e) {
            ApiManager._handleBitBucketExceptions(e);
            console.error(`got error while do request for url: ${fullPath} error: ${e}`);
            throw e;
        }
    }

    async getRepository({ projectKey, repositorySlug }) {
        return this._doRequest({
            method: 'get',
            url: `/rest/api/1.0/projects/${projectKey}/repos/${repositorySlug}`
        });
    }

    async getRepositories() {
        const repositoriesResponse = await this._doRequest({
            method: 'get',
            url: '/rest/api/1.0/repos',
            params: {
                limit: config.MAX_PAGE_LENGTH
            }
        });
        return repositoriesResponse;
    }

    async getDefaultBranch({ projectKey, repositorySlug }) {
        const defaultBranchResponse = await this._doRequest({
            method: 'get',
            url: `/rest/api/1.0/projects/${projectKey}/repos/${repositorySlug}/branches/default`
        });
        return {
            branchName: defaultBranchResponse.displayId,
            id: defaultBranchResponse.id,
            ref: defaultBranchResponse.latestCommit
        };
    }

    async _getLatestBranchReference({ projectKey, repositorySlug, branchName }) {
        const branchesResponse = await this._doRequest({
            method: 'get',
            url: `/rest/api/1.0/projects/${projectKey}/repos/${repositorySlug}/branches`,
            params: {
                filterText: branchName
            }
        });
        const relevantBranch = branchesResponse.find(b => b.displayId === branchName);
        return relevantBranch ? relevantBranch.latestCommit : null;
    }

    async _createNewBranch({ projectKey, repositorySlug, name, startPoint }) {
        await this._doRequest({
            method: 'post',
            url: `/rest/api/1.0/projects/${projectKey}/repos/${repositorySlug}/branches`,
            data: {
                name,
                startPoint
            }
        });
    }

    async getFiles({ projectKey, repositorySlug, ref }) {
        const params = {
            limit: config.MAX_PAGE_LENGTH
        };
        if (ref) params.at = ref;
        const filesResponse = await this._doRequest({
            method: 'get',
            url: `/rest/api/1.0/projects/${projectKey}/repos/${repositorySlug}/files`,
            params
        });
        return filesResponse.filter(filePath => checkIfFileIsValidForScan(filePath));
    }

    async getFileContent({ projectKey, repositorySlug, ref, filePath }) {
        const fileContent = await this._doRequest({
            method: 'get',
            url: `/rest/api/1.0/projects/${projectKey}/repos/${repositorySlug}/raw/${filePath}`,
            print: false,
            params: {
                at: ref
            },
            blockPagination: true
        });
        if (typeof fileContent === 'object') return JSON.stringify(fileContent, null, '\t');
        return fileContent;
    }

    /**
     * get file path and returns the path of the father node
     * e.g 1: '/readme.md' -> ['', 'readme.md']
     * e.g 2: '/test1/readme.md' -> ['/test1', 'readme.md']
     * e.g 3: '/test2/test1/readme.md' -> ['/test2/test1', 'readme.md']
     * @param path - String
     * @returns {Array of Strings: [previous path node, file name]}
     */
    _getPreviousPath(path) {
        const arr = path.split('/').filter(f => f);
        const fileName = arr.pop();
        return [arr.join('/'), fileName];
    }

    async _getCommitId({ projectKey, repositorySlug, branchName, filePath }) {
        console.info(`getting previous file path of path: ${filePath}`);
        const [previousFilePath, fileName] = this._getPreviousPath(filePath);
        console.info(`the file name is: ${fileName} and the previous file path is: ${previousFilePath}`);

        const lastModified = await this._doRequest({
            method: 'get',
            url: `/rest/api/1.0/projects/${projectKey}/repos/${repositorySlug}/last-modified${previousFilePath && !previousFilePath.startsWith('/') ? '/' : ''}${previousFilePath}`,
            params: {
                at: branchName
            }
        });

        if (lastModified.files && lastModified.files && lastModified.files[fileName]) {
            const commitId = lastModified.files[fileName].id;
            console.info(`the last commit id of ${fileName} is: ${commitId}`);
            return commitId;
        }
        console.info(`file ${fileName} does not exist - it's a new file`);
        return null;
    }

    async _commitFiles({ projectKey, repositorySlug, branchName, commitMessage, files }) {
        console.info(`commit ${files.length} files on branch: ${branchName} - repo: ${projectKey}/${repositorySlug}`);
        let newCommitResponse;

        for (const file of files) {
            console.info(`start commit file path: ${file.path}`);
            const bodyFormData = new FormData();
            const sourceCommitId = await this._getCommitId({ projectKey, repositorySlug, branchName, filePath: file.path });
            if (sourceCommitId) bodyFormData.append('sourceCommitId', sourceCommitId); // the commit ID of the file before it was edited, used to identify if content has changed. don't pass the argument if it's a new file
            bodyFormData.append('message', commitMessage);
            bodyFormData.append('content', file.content);
            bodyFormData.append('branch', branchName); // the branch on which the path should be modified or created

            newCommitResponse = await this._doRequest({
                method: 'put',
                url: `/rest/api/1.0/projects/${projectKey}/repos/${repositorySlug}/browse${!file.path.startsWith('/') ? '/' : ''}${file.path}`,
                data: bodyFormData,
                headers: bodyFormData.getHeaders()
            });

            console.info(`successfully commit file ${file.path} with commit id: ${newCommitResponse.id}`);
        }

        return newCommitResponse;
    }

    async _createPullRequest({ projectKey, repositorySlug, title, fromBranch, toBranch, description }) {
        try {
            const newBranchResponse = await this._doRequest({
                method: 'post',
                url: `/rest/api/1.0/projects/${projectKey}/repos/${repositorySlug}/pull-requests`,
                data: {
                    title,
                    description,
                    state: 'OPEN',
                    open: true,
                    closed: false,
                    fromRef: {
                        id: fromBranch
                    },
                    toRef: {
                        id: toBranch
                    },
                    locked: false
                }
            });
            return newBranchResponse;
        } catch (e) {
            if (e.response && e.response.status === 409) {
                console.error(`can't create PR of projectKey: ${projectKey} repository: ${repositorySlug} because PR because PR already exist from branch: ${fromBranch} to branch: ${toBranch}. error data: ${JSON.stringify(e.response.data)}`);
            }
            throw e;
        }
    }

    /**
     * @param workspace - String e.g: livnoni
     * @param repositoryName - String e.g: my-repo-name
     * @param sourceBranchName - String e.g: master
     * @param files - Array of objects e.g: {path: 'src/yudaTestFile.tf', content: STRING}
     * @param commitMessage - String e.g: Fix bucket encryption on app-bucket
     * @param title - String e.g: [BC] - terraform security bug
     * @param description - String e.g: BridgeCrew has created this PR to tix one or more vulnerable lines in the terraform file
     * @param closeSourceBranch - Boolean e.g: true
     * @param newBranchName - String - not required, if omitted it created by default as bc-fix-UUID
     * @returns reference object of the pull request
     */
    async createPullRequest({ projectKey, repositorySlug, sourceBranchName, files,
        commitMessage = config.PR.commitDefaultMessage,
        title = config.PR.defaultTitle,
        description = config.PR.defaultDescription,
        newBranchName = `${config.PR.newBranchPrefix}-${v4()}` }) {
        const branchRef = await this._getLatestBranchReference({ projectKey, repositorySlug, branchName: sourceBranchName });
        if (!branchRef) throw new Error(`can't create new pull request for: ${projectKey}/${repositorySlug} branch: ${sourceBranchName} because branch reference doe'st exist`);
        await this._createNewBranch({ projectKey, repositorySlug, name: newBranchName, startPoint: branchRef });
        await this._commitFiles({ projectKey, repositorySlug, branchName: newBranchName, commitMessage, files });
        const pullRequestObj = await this._createPullRequest({ projectKey, repositorySlug, title, fromBranch: newBranchName, toBranch: sourceBranchName, description });
        console.info(`successfully created pull request (${pullRequestObj.title}):\n`
            + `id: ${pullRequestObj.id}\n`
            + `title: ${pullRequestObj.title}\n`
            + `createdDate: ${pullRequestObj.createdDate}\n`
            + `state: ${pullRequestObj.state}\n`
            + `description: ${pullRequestObj.description}\n`
            + `author: ${pullRequestObj.author.user.displayName}\n`
            + `from branch: ${pullRequestObj.fromRef.displayId}\n`
            + `to branch: ${pullRequestObj.toRef.displayId}\n`
            + `link: ${pullRequestObj.links.self[0].href}`);
        return pullRequestObj;
    }

    async commitAndPush({ projectKey, repositorySlug, branchName, files }) {
        const branchRef = await this._getLatestBranchReference({ projectKey, repositorySlug, branchName });
        if (!branchRef) throw new Error(`can't commit and push for: ${projectKey}/${repositorySlug} branch: ${branchName} because branch reference doe'st exist`);
        const commitMessage = files.map(file => file.commitMessage).join('\n');
        const commitRes = await this._commitFiles({ projectKey, repositorySlug, branchName, commitMessage, files });
        console.info(`successfully commit files to ${branchName}`);
        return commitRes;
    }

    async getHooks({ projectKey, repositorySlug }) {
        const params = {
            limit: config.MAX_PAGE_LENGTH
        };
        const filesResponse = await this._doRequest({
            method: 'get',
            url: `/rest/api/1.0/projects/${projectKey}/repos/${repositorySlug}/webhooks`,
            params
        });
        return filesResponse;
    }

    async setHook({ projectKey, repositorySlug, url, name, events }) {
        await this._doRequest({
            method: 'post',
            url: `/rest/api/1.0/projects/${projectKey}/repos/${repositorySlug}/webhooks`,
            data: {
                name,
                events,
                url,
                active: true
            }
        });
    }

    async deleteHook({ projectKey, repositorySlug, id }) {
        await this._doRequest({
            method: 'delete',
            url: `/rest/api/1.0/projects/${projectKey}/repos/${repositorySlug}/webhooks/${id}`
        });
    }

    async updateBuild({ commitHash, data }) {
        const buildResponse = await this._doRequest({
            method: 'post',
            url: `/rest/build-status/1.0/commits/${commitHash}`,
            data
        });
        return buildResponse;
    }

    async getPRLatestCommit({ projectKey, repositorySlug, pr }) {
        const latestCommitResponse = await this._doRequest({
            method: 'get',
            url: `/rest/api/1.0/projects/${projectKey}/repos/${repositorySlug}/pull-requests/${pr}/commits`
        });
        return latestCommitResponse.length ? latestCommitResponse[0].id : null;
    }

    async getPullRequestDiffStat({ workspace, repositoryName, pullRequestId }) {
        const pullRequestDiffStatResponse = await this._doRequest({
            method: 'get',
            url: `/rest/api/1.0/projects/${workspace}/repos/${repositoryName}/pull-requests/${pullRequestId}/changes`,
            params: {
                changeScope: 'ALL',
                withComments: false
            }
        });
        const filteredFiles = pullRequestDiffStatResponse.filter(prDiffObj => {
            const filePath = prDiffObj.path.toString;
            return prDiffObj.type !== 'DELETE'
                && checkIfFileIsValidForScan(filePath);
        });
        console.info(`filtered files: ${filteredFiles.length} of ${pullRequestDiffStatResponse.length} pull request files changes`);
        return filteredFiles;
    }

    async createReport({ workspace, repositoryName, commitHash, reportId, status, data, reportParams }) {
        const newReportResponse = await this._doRequest({
            method: 'put',
            url: `/rest/insights/latest/projects/${workspace}/repos/${repositoryName}/commits/${commitHash}/reports/${reportId}`,
            data: {
                result: status,
                details: reportParams.details,
                title: reportParams.title,
                reporter: reportParams.reporter,
                link: reportParams.link,
                logoUrl: reportParams.logoUrl,
                data
            }
        });
        return newReportResponse;
    }

    async getReportAnnotations({ workspace, repositoryName, commitHash, reportId, status, data, reportParams }) {
        const reportAnnotations = await this._doRequest({
            method: 'get',
            url: `/rest/insights/latest/projects/${workspace}/repos/${repositoryName}/commits/${commitHash}/reports/${reportId}/annotations`
        });
        return reportAnnotations;
    }

    async setReportAnnotations({ workspace, repositoryName, commitHash, reportId, annotations }) {
        const newReportAnnotationsResponse = await this._doRequest({
            method: 'post',
            url: `/rest/insights/latest/projects/${workspace}/repos/${repositoryName}/commits/${commitHash}/reports/${reportId}/annotations`,
            data: { annotations }
        });
        return newReportAnnotationsResponse;
    }

    cloneRepo({ fullRepoPath, customerName, reposFolderPath }) {
        const baseUrlSplitResult = this.baseUrl.split('://');

        // For develop support - in develop we use http
        const httpOrHttps = baseUrlSplitResult[0];

        const command = `git clone --depth 1 -c "${httpOrHttps}.extraHeader=Authorization: Bearer ${this.accessToken}" ${this.baseUrl}/scm/${fullRepoPath}.git ${reposFolderPath}/${customerName}/${fullRepoPath}`;
        console.log('[BBEnterpriseApi][cloneRepo] - this is the clone command string: ', command);
        execSync(command, { encoding: 'utf8', stdio: 'inherit' });
    }
}

module.exports = ApiManager;