const axios = require('axios');
const axiosRetry = require('axios-retry');
const File = require('@bridgecrew/nodeUtils/models/VersionControl/file');
const { v4 } = require('uuid');
const { execSync } = require('child_process');
const { checkIfFileIsValidForScan } = require('../../../utils/index');
const { apiManager, DEFAULT_BRANCH, BLOB_TYPE, ENCODING } = require('../conf/config');

class ApiManager {
    constructor({ accessToken }) {
        if (!accessToken) throw new Error('can\'t create new ApiManager without access token');

        this.accessToken = accessToken;

        this.axiosInstance = axios.create({
            baseURL: `${apiManager.baseURL}`,
            headers: {
                Authorization: `Bearer ${this.accessToken}`,
                'Content-Type': 'application/json'
            }
        });
        this.axiosInstanceVSTS = axios.create({
            baseURL: apiManager.VSTS_URL,
            headers: {
                Authorization: `Bearer ${this.accessToken}`
            }
        });
        axiosRetry(this.axiosInstance, {
            retries: 3,
            retryDelay: (retryCount) => {
                console.warn(`request failed with status code - 503, retry number: ${retryCount}`);
                return 1000; // 1sec delay
            },
            retryCondition: e => axiosRetry.isNetworkOrIdempotentRequestError(e) && e?.response?.status && e?.response?.status === 503 // retry only when status code is 503
        });

        axiosRetry(this.axiosInstanceVSTS, {
            retries: 3,
            retryDelay: (retryCount) => {
                console.warn(`request failed with status code - 503, retry number: ${retryCount}`);
                return 1000; // 1sec delay
            },
            retryCondition: e => axiosRetry.isNetworkOrIdempotentRequestError(e) && e?.response?.status && e?.response?.status === 503 // retry only when status code is 503
        });
    }

    static _handleAzureExceptions(error) {
        if (!error) return;
        const { response } = error;
        if (!response) return;
        const { status, statusText, data } = response;
        if (status || statusText || data) {
            console.error('got error from Azure API:\n'
                + `status: ${status}\n`
                + `statusText: ${statusText}\n`
                + `data: ${data ? JSON.stringify(data) : null}`);
        }
    }

    async _doRequest({ axiosClient, method, url, data, params, print = true, headers }) {
        const fullPath = `${axiosClient.defaults.baseURL}/${url || ''}`;
        if (print) console.info(`[http request] - ${method ? method.toUpperCase() : ''} ${fullPath} ${data ? JSON.stringify(data) : ''}`);
        try {
            const httpResponse = await axiosClient.request({
                url,
                method,
                data,
                params,
                headers
            });
            const responseData = httpResponse.data;
            let { next, values, page } = responseData;
            if (!next) return responseData.values ? responseData.values : responseData;
            console.info(`got more files then: ${responseData.pagelen} - starting pagination`);
            const paramsWithoutPagelen = { ...params };
            delete paramsWithoutPagelen.pagelen;
            while (next && values.length < apiManager.MAX_FILES) {
                console.info(`pagination - getting the ${page + 1} page, total value length: ${values.length} next url: ${next}`);
                const bulkResponse = await this.axiosInstance.request({
                    url: next,
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
            ApiManager._handleAzureExceptions(e);
            console.error(`got error while do request for url: ${fullPath} error: ${e}`);
            throw e;
        }
    }

    async getRepositories({ project }) {
        const repositoriesResponse = await this._doRequest({
            axiosClient: this.axiosInstance,
            method: 'get',
            url: `${project.org}/${project.id}/_apis/git/repositories?api-version=${apiManager.API_VERSION}`
        });
        return repositoriesResponse;
    }

    async getRepository({ project, repositoryName }) {
        const repositoriesResponse = await this._doRequest({
            axiosClient: this.axiosInstance,
            method: 'get',
            url: `${project}/_apis/git/repositories/${repositoryName}?api-version=${apiManager.API_VERSION}`
        });
        return repositoriesResponse;
    }

    async getHooks({ org }) {
        const getHooksResponse = await this._doRequest({
            axiosClient: this.axiosInstance,
            method: 'get',
            url: `${org}/_apis/hooks/subscriptions?api-version=${apiManager.API_VERSION}`
        });
        return getHooksResponse.count ? getHooksResponse.value : [];
    }

    async setHook({ org, publisherId, eventType, consumerId, publisherInputs, consumerActionId, consumerInputs }) {
        const setHookResponse = await this._doRequest({
            axiosClient: this.axiosInstance,
            method: 'post',
            url: `${org}/_apis/hooks/subscriptions?api-version=${apiManager.API_VERSION}`,
            data: {
                publisherId,
                eventType,
                consumerId,
                consumerActionId,
                publisherInputs,
                consumerInputs
            }
        });
        return setHookResponse;
    }

    async deleteHook({ org, subscriptionId }) {
        const deleteHookResponse = await this._doRequest({
            axiosClient: this.axiosInstance,
            method: 'delete',
            url: `${org}/_apis/hooks/subscriptions/${subscriptionId}?api-version=${apiManager.API_VERSION}`
        });
        return deleteHookResponse;
    }

    async getProjects(orgs) {
        const projects = [];
        for (const org of orgs) {
            let skip = 0;
            let next = true;
            try {
                while (next) {
                    const projs = await this._doRequest({
                        axiosClient: this.axiosInstance,
                        method: 'get',
                        url: `${org}/_apis/projects?api-version=${apiManager.API_VERSION}&$skip=${skip}`
                    });
                    if (Array.isArray(projs?.value)) {
                        const organizationProjects = projs.value.map(p => ({
                            id: p.id,
                            name: p.name,
                            org
                        }));
                        projects.push(...organizationProjects);
                    }
                    if (projs?.count === 100) { // max project in response
                        skip += 100;
                    } else {
                        next = false;
                    }
                }
            } catch (err) {
                console.error(`[getProjects] - Getting while trying to access organization ${org}`, err);
            }
        }
        return projects.map(p => p);
    }

    async getProfile() {
        return await this._doRequest({
            axiosClient: this.axiosInstanceVSTS,
            method: 'get',
            url: `_apis/profile/profiles/me?api-version=${apiManager.API_VERSION}`
        });
    }

    async getAccounts({ memberId }) {
        const accounts = await this._doRequest({
            axiosClient: this.axiosInstanceVSTS,
            method: 'get',
            url: `_apis/accounts?api-version=${apiManager.API_VERSION}&memberId=${memberId}`
        });
        return accounts.value.map(r => r.accountName);
    }

    async _createPullRequest({ project, repositoryName, title, fromBranch, toBranch, description, closeSourceBranch = true }) {
        const newBranchResponse = await this._doRequest({
            axiosClient: this.axiosInstance,
            method: 'post',
            url: `${project}/_apis/git/repositories/${repositoryName}/pullrequests?api-version=${apiManager.API_VERSION}`,
            data: {
                title,
                sourceRefName: `refs/heads/${fromBranch}`,
                targetRefName: `refs/heads/${toBranch}`,
                description,
                completionOptions: {
                    deleteSourceBranch: closeSourceBranch
                }
            }
        });
        return newBranchResponse;
    }

    async createPullRequest({ project, repositoryName, sourceBranchName, files,
        commitMessage = apiManager.PR.commitDefaultMessage,
        commitAuthor = apiManager.PR.defaultAuthor,
        title = apiManager.PR.defaultTitle,
        description = apiManager.PR.defaultDescription,
        closeSourceBranch = apiManager.PR.defaultCloseSourceBranch,
        newBranchName = `${apiManager.PR.newBranchPrefix}-${v4()}` }) {
        const branchObjectId = await this._getObjectIdByBranch({ project, repositoryName, branchName: sourceBranchName });
        if (!branchObjectId) throw new Error(`can't create new pull request for: ${project}/${repositoryName} branch: ${sourceBranchName} because branch reference doe'st exist`);
        await this._commitFiles({ project, repositoryName, oldObjectId: branchObjectId, branchName: newBranchName, commitMessage, commitAuthor, files, closeSourceBranch });
        const pullRequestObj = await this._createPullRequest({ project, repositoryName, title, fromBranch: newBranchName, toBranch: sourceBranchName, description });
        console.info(`successfully created pull request (${pullRequestObj.title}):\n`
            + `id: ${pullRequestObj.pullRequestId}\n`
            + `state: ${pullRequestObj.status}\n`
            + `description: ${pullRequestObj.description}\n`
            + `author: ${pullRequestObj.createdBy.displayName}\n`
            + `sourceCommit: ${pullRequestObj.lastMergeSourceCommit.commitId}\n`
            + `destinationCommit: ${pullRequestObj.lastMergeTargetCommit.commitId}\n`
            + `from branch: ${pullRequestObj.sourceRefName}\n`
            + `to branch: ${pullRequestObj.targetRefName}`);
        return pullRequestObj;
    }

    async commitAndPush({ project, repositoryName, branch, files,
        commitMessage = files.map(file => file.commitMessage).join('\n') || apiManager.PR.commitDefaultMessage,
        commitAuthor = apiManager.PR.defaultAuthor }) {
        const branchObjectId = await this._getObjectIdByBranch({ project, repositoryName, branchName: branch });
        if (!branchObjectId) throw new Error(`can't create new commit and push for: ${project}/${repositoryName} branch: ${branch} because branch reference doesn't exist`);
        return await this._commitFiles({ project, repositoryName, oldObjectId: branchObjectId, branchName: branch, commitMessage, commitAuthor, files });
    }

    async _getObjectIdByBranch({ project, repositoryName, branchName }) {
        console.info(`getting latest object id of owner: ${project} with repo name: ${repositoryName} of branch: ${branchName}`);
        try {
            const refResp = await this._doRequest({
                axiosClient: this.axiosInstance,
                method: 'get',
                url: `${project}/_apis/git/repositories/${repositoryName}/refs?api-version=${apiManager.API_VERSION}&filter=heads/${branchName}`
            });
            return refResp.count > 0 ? refResp.value[0].objectId : null;
        } catch (e) {
            ApiManager._handleAzureExceptions(e);
            throw e;
        }
    }

    async _commitFiles({ project, repositoryName, branchName, oldObjectId, commitMessage, commitAuthor, authorEmail, files }) {
        console.info(`commit ${files.length} files on branch: ${branchName} - repo: ${repositoryName}(${project})`);
        const changes = files.map(file => ({
            changeType: 'edit',
            item: {
                path: file.path
            },
            newContent: {
                content: file.content,
                contentType: 'rawText'
            }
        }));
        const data = {
            refUpdates: [
                {
                    name: `refs/heads/${branchName}`,
                    oldObjectId
                }
            ],
            commits: [
                {
                    comment: commitMessage,
                    author: {
                        name: commitAuthor,
                        email: authorEmail
                    },
                    changes
                }
            ]
        };
        const commitAndPushResp = await this._doRequest({
            axiosClient: this.axiosInstance,
            method: 'post',
            url: `${project}/_apis/git/repositories/${repositoryName}/pushes?&api-version=${apiManager.API_VERSION}`,
            data
        });
        return commitAndPushResp;
    }

    async _getCommit({ owner, repoName, commitId }) {
        const commitResponse = await this._doRequest({
            axiosClient: this.axiosInstance,
            method: 'get',
            url: `${owner}/_apis/git/repositories/${repoName}/commits/${commitId}?api-version=${apiManager.API_VERSION}`
        });
        return commitResponse.treeId;
    }

    async getCommitChanges({ org, projectId, repoId, commit }) {
        const commitChangesResponse = await this._doRequest({
            axiosClient: this.axiosInstance,
            method: 'get',
            url: `${org}/${projectId}/_apis/git/repositories/${repoId}/commits/${commit}/changes?api-version=${apiManager.API_VERSION}`
        });
        return commitChangesResponse;
    }

    async _getTree({ owner, repoName, treeSha }) {
        const treeResponse = await this._doRequest({
            axiosClient: this.axiosInstance,
            method: 'get',
            url: `${owner}/_apis/git/repositories/${repoName}/trees/${treeSha}?api-version=${apiManager.API_VERSION}&recursive=true`
        });
        return treeResponse ? treeResponse.treeEntries : [];
    }

    async getFileContent({ owner, repositoryName, filePath, sha }) {
        const fileContent = await this._doRequest({
            axiosClient: this.axiosInstance,
            method: 'get',
            url: `${owner}/_apis/git/repositories/${repositoryName}/items?path=${filePath}&api-version=${apiManager.API_VERSION}&versionDescriptor.version=${sha}&versionDescriptor.versionType=commit&includeContent=true`,
            print: false
        });
        return fileContent.content;
    }

    async getFiles({ repository, repoId, prefix }) {
        try {
            const { owner } = repository;
            const repoName = repository.name;

            // get reference of specific branch:
            const referenceSha = await this._getObjectIdByBranch({ project: owner, repositoryName: repoName, branchName: repository.defaultBranch || DEFAULT_BRANCH });
            if (referenceSha === null) {
                return [];
            }
            const treeSha = await this._getCommit({ owner, repoName, commitId: referenceSha });
            // get a single tree using the SHA1 value of the tree node:
            const treeArr = await this._getTree({ owner, repoName, treeSha });
            // filter the relevant file:
            const filterFiles = treeArr.filter(node => node.gitObjectType === BLOB_TYPE && checkIfFileIsValidForScan(node.relativePath)); // BLOB_TYPE means it's a file (and not directory)
            console.info(`repository: ${repoName} after filter, left ${filterFiles.length} from total ${treeArr.length} nodes`);

            return filterFiles.map((file) => new File(
                {
                    repoId,
                    branchRef: referenceSha,
                    path: file.relativePath,
                    repo: repository,
                    owner,
                    size: file.size,
                    encoding: ENCODING,
                    prefix
                }
            ));
        } catch (e) {
            console.error(`Failed executing get files on repository: ${JSON.stringify(repository)}, with error: ${e.message}`);
            throw e;
        }
    }

    async getFileContentFromCommit({ org, projectId, repoId, filePath, commit }) {
        const file = await this._doRequest({
            axiosClient: this.axiosInstance,
            method: 'get',
            params: {
                path: filePath,
                'versionDescriptor.version': commit,
                'versionDescriptor.versionType': 'commit',
                includeContent: true,
                'api-version': apiManager.API_VERSION
            },
            url: `${org}/${projectId}/_apis/git/repositories/${repoId}/items`
        });
        return file.content;
    }

    async setPullRequestStatus({ org, projectId, repoId, pr, data }) {
        const statusRes = await this._doRequest({
            axiosClient: this.axiosInstance,
            method: 'post',
            url: `${org}/${projectId}/_apis/git/repositories/${repoId}/pullRequests/${pr}/statuses?api-version=${apiManager.API_VERSION}`,
            data
        });
        console.info('setPullRequestStatus for', org, projectId, repoId, pr, data, 'response', statusRes);
        return statusRes;
    }

    async createPRThread({ org, projectId, repoId, pr, comments }) {
        console.log('createPRThread', { org, projectId, repoId, pr, comments });
        const threadRes = await this._doRequest({
            axiosClient: this.axiosInstance,
            method: 'post',
            url: `${org}/${projectId}/_apis/git/repositories/${repoId}/pullRequests/${pr}/threads?api-version=6.0`,
            data: { comments, status: 1 }
        });
        console.info('threadRes', threadRes);
        return threadRes;
    }

    async updatePRThread({ org, projectId, repoId, pr, comments, id }) {
        console.log('updatePRThread', { org, projectId, repoId, pr, comments });
        const threadRes = await this._doRequest({
            axiosClient: this.axiosInstance,
            method: 'patch',
            url: `${org}/${projectId}/_apis/git/repositories/${repoId}/pullRequests/${pr}/threads/${id}?api-version=6.0`,
            data: { comments, status: 1 }
        });
        console.info('threadRes', threadRes);
        return threadRes;
    }

    cloneRepo({ fullRepoName, customerName, reposFolderPath }) {
        try {
            const splittedFullRepoName = fullRepoName.split('/');
            const repoName = splittedFullRepoName.pop();
            const repoOwnerAndOrganization = splittedFullRepoName.join('/');
            if (!repoOwnerAndOrganization || !repoName) {
                throw new Error(`Failed to extract repoOwnerAndOrganization && repoName from fullRepoName. 
                fullRepoName: ${fullRepoName}, repoOwnerAndOrganization: ${repoOwnerAndOrganization} repoName: ${repoName}`);
            }

            console.log('[AzureReposApi][cloneRepo] - cloning repo with params:', { repoOwnerAndOrganization, repoName });
            const gitCloneString = this.createGitCloneString({
                repoOwnerAndOrganization,
                repoName,
                isShallowClone: true
            });
            const command = `git clone ${gitCloneString} "${reposFolderPath}/${customerName}/${fullRepoName}"`;
            console.log(`[AzureReposApi][cloneRepo] - cloning repo with command:${command}`);
            execSync(command, { encoding: 'utf8', stdio: 'inherit' });
        } catch (e) {
            console.error(`[AzureReposApi][cloneRepo] - got exception while cloning repo: ${fullRepoName} for customer: ${customerName} error: ${e}`);
            throw e;
        }
    }

    createGitCloneString({ repoOwnerAndOrganization, repoName, isShallowClone }) {
        const baseCloneUrl = encodeURI(`${apiManager.baseURL}/${repoOwnerAndOrganization}/_git/${repoName}`);
        const options = `-c http.extraHeader="Authorization: Bearer ${this.accessToken}" ${isShallowClone ? '--depth 1' : ''}`;
        return `${options} ${baseCloneUrl}`;
    }
}

module.exports = ApiManager;