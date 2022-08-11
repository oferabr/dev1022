const vcsSSmMgr = require('@bridgecrew/vcs-ssm-mgr');
const RemoteLambda = require('@bridgecrew/nodeUtils/remoteLambda/invoke');
const Repository = require('@bridgecrew/nodeUtils/models/VersionControl/repository');
const { THRESHOLD_SEVERITY_NAMES, PR_STATUS } = require('@bridgecrew/dal-layer');
const { suppressViolationsUponMergeToDefaultBranch, handleRevokedVcs, getCommentMarkdownText, checkIsSuppressed } = require('@bridgecrew/nodeUtils/vcs/utils');
const { promiseAllWithRateLimit } = require('@bridgecrew/nodeUtils/common/promiseAllWithRateLimit');
const { removeExcludedFiles, isViolationRelevant } = require('@bridgecrew/nodeUtils/vcs/repoSettingSchema');
const File = require('@bridgecrew/nodeUtils/models/VersionControl/file');
const PullRequest = require('@bridgecrew/nodeUtils/models/VersionControl/pullRequest');
const { TEXT_CONFIG } = require('@bridgecrew/nodeUtils/vcs/uiTextConfig');
const { isViolationRelevantByEnforcementRules } = require('@bridgecrew/vcs-utils');
const { VIOLATION_SEVERITIES_ORDER, SOURCE_TYPES, SCANNER_TYPE, VIOLATION_STATUSES, AZURE_REPOS_CHECK_STATUSES } = require('@bridgecrew/nodeUtils/models/Enums');
const { MissingIntegrationError } = require('@bridgecrew/vcs-classes');
const { BC_HOOKS_STATUS, BRANCH_PREFIXES } = require('../../../utils/index');
const AzureReposCodeReviewIntegration = require('../CodeReview/index');
const BaseVCSClass = require('../../../models/baseClass');

const settingsMgrApiLambda = new RemoteLambda(process.env.SETTINGS_MGR_API_LAMBDA);
const cicdRemoteLambda = new RemoteLambda(process.env.CICD_API_LAMBDA_NAME);
const { SCAN_RESULTS_BUCKET } = process.env;
const TokenManager = require('../apis/tokenManager');
const ApiManager = require('../apis/apiManager');
const config = require('../conf/config').serviceManager;

const createEventType = 'git.pullrequest.created';
const updateEventType = 'git.pullrequest.updated';
const shouldPersistFiles = process.env.PERSIST_FILES !== 'false';
const CHUNK_SIZE = 5000;
const { DEFAULT_BRANCH, SRC, webhook: webhookConf } = require('../conf/config');

class AzureReposServiceMgr extends BaseVCSClass {
    /**
     * this.multiIntegrations: map of integrations
     * this.customerName: String
     */
    constructor() {
        super(SOURCE_TYPES.AZURE_REPOS);
        this.customerName = null;
        this.module = null;
        this.supportedMultiIntegrations = true;
        this.multiIntegrations = {};
    }

    _isRateLimitError(err) {
        const { statusCode, message } = this._extractDetailsFromError(err);
        return statusCode === 429 || (message && message.includes('exceeding usage of resource')); // TF400733: The request has been canceled: Request was blocked due to exceeding usage of resource <resource name> in namespace <namespace ID>.
    }

    _getIntegrationId({ projectName, projectId, usedIntegrationIds = [] }) {
        for (const [integrationId, integrationData] of Object.entries(this.multiIntegrations)) {
            if (!usedIntegrationIds.includes(integrationId) && integrationData.projects.find(project => `${project.org}/${project.name}` === projectName || project.id === projectId)) {
                return integrationId;
            }
        }
        console.error(`[AzureReposServiceMgr][_getIntegrationIdByProjectName] - integration id not found for customerName: '${this.customerName}' projectName: ${projectName} or projectId: ${projectId}`);
        return null;
    }

    async _callApiManagerWithFallBack({ functionName, functionArgs, projectName, projectId, returnIntegrationId = false }) {
        const usedIntegrationIds = [];
        let lastError = null;
        let integrationId = null;
        do {
            try {
                integrationId = this._getIntegrationId({ projectName, projectId, usedIntegrationIds });
                if (integrationId) {
                    usedIntegrationIds.push(integrationId);
                    const results = await this.multiIntegrations[integrationId].apiManager[functionName](functionArgs);
                    if (returnIntegrationId) {
                        return { results, integrationId };
                    }
                    return results;
                }
            } catch (err) {
                lastError = err;
                console.error(`[AzureReposServiceMgr][_useFallBackIntegration] - could not find integration id for project ${projectName} / ${projectId}`, err);
                const { statusCode } = this._extractDetailsFromError(err);
                if (statusCode !== 401 && statusCode !== 403) throw err;
            }
        } while (integrationId);
        if (lastError) {
            throw lastError;
        }
        throw new MissingIntegrationError(projectName, projectId, this.customerName);
    }

    async _getAccounts(apiManager) {
        const profile = await apiManager.getProfile();
        if (!profile) throw new Error('Failed to get profile');
        return apiManager.getAccounts({ memberId: profile.id });
    }

    async _getProjects(orgs, apiManager) {
        return apiManager.getProjects(orgs);
    }

    async _apiManagerInitialization({ module, refreshToken }) {
        const vcsSSmMgrInstance = vcsSSmMgr.getInstance();
        const clientAssertion = await vcsSSmMgrInstance.getClientSecret(SOURCE_TYPES.AZURE_REPOS, module);
        const tokenManager = new TokenManager({ refreshToken, clientAssertion, options: { module } });
        const apiGatewayUrl = await vcsSSmMgrInstance.getGlobalRedirectUrl(module);
        console.log('Using this apiGatewayUrl:', apiGatewayUrl);
        await tokenManager.init(apiGatewayUrl);
        let accessToken;
        try {
            const tokenResults = await tokenManager.getTokenData(true);
            accessToken = tokenResults.access_token;
        } catch (e) {
            console.log('[AzureReposServiceMgr][_apiManagerInitialization] - token revoked for customer ', this.customerName);
            throw e;
        }
        return new ApiManager({ accessToken });
    }

    _filterSelectedRepositories({ repositories }) {
        const multiIntegrationsSelectedRepositories = [];
        Object.values(this.multiIntegrations).forEach(integrationData => {
            multiIntegrationsSelectedRepositories.push(...integrationData.selectedRepositories);
        });
        const selectedRepositories = multiIntegrationsSelectedRepositories.reduce((obj, repoFullName) => ({ ...obj, [repoFullName]: true }), {});
        return repositories.filter(repo => selectedRepositories[`${repo.owner}/${repo.name}`]);
    }

    async _handleInitError({ customerName, err, integrationId, repositories }) {
        console.error(`[AzureReposServiceMgr][_handleInitError] - init function error for customerName: '${customerName}', integration id: ${integrationId}`, err);
        try {
            const error = JSON.parse(err.message);
            if (error.status >= 400 && error.data.ErrorDescription === 'The access token is not valid') {
                await handleRevokedVcs({
                    customerName,
                    vcsType: SOURCE_TYPES.AZURE_REPOS,
                    integrationId,
                    repositories,
                    integrationLambdaName: process.env.INTEGRATION_API_LAMBDA,
                    emailApiLambdaName: process.env.EMAIL_SERVICE_LAMBDA
                });
            }
        } catch (error) {
            console.error(`[AzureReposServiceMgr][_handleInitError] - could not parse error message or handleRevokedVcs function failed for customerName '${customerName}' with integration id : ${integrationId}`, error);
        }
    }

    async init({ customerName, repositoryFullName }) {
        this._createCustomLabels({ customerName });
        this.customerName = customerName;
        const integrations = await this._getIntegrationData({ customerName, repositoryFullName });
        const failedIntegrations = [];
        if (integrations && integrations.length > 0) {
            this.module = integrations[0]?.params?.module;
            await Promise.all(integrations.map(async integration => {
                try {
                    const { params, id, integration_details: integrationDetails } = integration;
                    const { module, repositories, reposSelectionType } = params;
                    const apiManager = await this._apiManagerInitialization({ module, refreshToken: params.refresh_token });
                    const orgs = await this._getAccounts(apiManager);
                    const projects = orgs?.length ? await this._getProjects(orgs, apiManager) : [];
                    console.log(`[AzureReposServiceMgr][init] - organizations for customer '${customerName}' with integration id: ${id}, are: \n${JSON.stringify(orgs)}`);
                    const selectedRepositoriesMap = (repositories || []).reduce((repositoriesMap, repo) => ({ ...repositoriesMap, [repo]: true }), {});
                    this.multiIntegrations[id] = {
                        selectedRepositories: repositories,
                        updatedByPcUser: integrationDetails.updatedByPcUser,
                        reposSelectionType,
                        apiManager,
                        orgs,
                        projects,
                        selectedRepositoriesMap
                    };
                } catch (err) {
                    failedIntegrations.push(integration.id);
                    await this._handleInitError({
                        customerName,
                        err,
                        integrationId: integration.id,
                        repositories: integration.params.repositories
                    });
                }
            }));
            if (Object.keys(this.multiIntegrations).length > 0) {
                console.info(`[AzureReposServiceMgr][init] - successfully finished ${failedIntegrations.length ? `with the exception of the following integrations: ${JSON.stringify(failedIntegrations)}` : ''}`, {
                    customerName,
                    integrations: JSON.stringify(this.multiIntegrations)
                });
                return true;
            }
        }
        console.error('[AzureReposServiceMgr][init] - There are no available integrations for Azure repos', { customerName });
        return false;
    }

    async generateToken({ code, options }) {
        try {
            if (!code) throw new Error('bad params - no code exist');
            const vcsSSmMgrInstance = vcsSSmMgr.getInstance();
            const clientAssertion = await vcsSSmMgrInstance.getClientSecret(SOURCE_TYPES.AZURE_REPOS, options.module);

            const tokenManager = new TokenManager({ code, clientAssertion, options });

            const apiGatewayUrl = await vcsSSmMgrInstance.getGlobalRedirectUrl(options.module);
            console.log('Using this apiGatewayUrl:', apiGatewayUrl);
            await tokenManager.init(apiGatewayUrl);

            const tokenData = await tokenManager.getTokenData();
            const apiManager = new ApiManager({ accessToken: tokenData.access_token });
            const profile = await apiManager.getProfile();
            if (!profile) throw new Error('Failed to get profile');
            const accounts = await apiManager.getAccounts({ memberId: profile.id });
            return Object.assign(tokenData, { accounts, profile });
        } catch (e) {
            console.error('got en error in generateToken', e);
            throw new Error(`Failed to generate token due to following error: ${e}`);
        }
    }

    async _getRepositoriesByIntegrationId(integrationId) {
        const integrationData = this.multiIntegrations[integrationId];
        if (!integrationData) {
            console.error(`[AzureReposServiceMgr][_getRepositoriesByIntegrationId] - integration id not found for customerName: '${this.customerName}' and integration id: ${integrationId}`);
            throw new Error('could not find integration data');
        }
        let repos = [];
        await promiseAllWithRateLimit({
            arr: integrationData.projects,
            callback: async (project) => {
                console.info(`getting repositories for project: ${JSON.stringify(project)}`);
                const repositories = await integrationData.apiManager.getRepositories({ project });
                console.info(`got repositories ${repositories.count} for org: ${project.org} for project: ${project.id}`);
                const newRepos = repositories.value.map((repo) => new Repository(
                    {
                        id: repo.id,
                        owner: `${project.org}/${repo.project.name}`,
                        name: repo.name,
                        fork: !!repo.isFork,
                        defaultBranch: repo.defaultBranch ? (repo.defaultBranch.split('/'))[2] : DEFAULT_BRANCH,
                        isPublic: repo.project.visibility === 'public',
                        url: repo.webUrl
                    }
                ));
                repos = repos.concat(newRepos);
            },
            maxConcurrent: 3
        });

        return repos;
    }

    _extractVCSParametersFromRepository({ repository }) {
        return { integrationId: repository.integrationId };
    }

    async getDuplicateRepositoriesObject({ customerName }) {
        console.log(`[AzureReposServiceMgr][getDuplicateRepositoriesObject] - getting repositories for project: ${customerName}`);
        const initResults = await this.init({ customerName });
        if (!initResults) return {};
        const { duplicateRepositoriesByIntegrationId } = await this._getRepositories();
        console.log('[AzureReposServiceMgr][getDuplicateRepositoriesObject] results', duplicateRepositoriesByIntegrationId);
        return duplicateRepositoriesByIntegrationId;
    }

    async _getRepositories(ignoreApiErrors = false) {
        const duplicateRepositoriesByIntegrationId = {};
        const repositories = [];
        const projectsMap = {};
        for (const [integrationId, integrationData] of Object.entries(this.multiIntegrations)) {
            if (Array.isArray(integrationData.projects) && integrationData.projects.length > 0) {
                for (const project of integrationData.projects) {
                    const { id, name, org } = project;
                    if (!projectsMap[id]) {
                        projectsMap[id] = { id, name, org, integrationIds: [integrationId] };
                    } else {
                        projectsMap[id].integrationIds.push(integrationId);
                    }
                }
            }
        }
        const projects = Object.values(projectsMap);
        this.errorHandler.errorPhaseIncreaseTotal(this.errorHandler.SYNC_REPOSITORIES_PHASE_NAME, projects.length);
        await promiseAllWithRateLimit({
            arr: projects,
            callback: async (project) => {
                console.info(`[AzureReposServiceMgr][_getRepositories] - getting repositories for project: ${JSON.stringify(project)}`);
                try {
                    const { integrationIds } = project;
                    const { results, integrationId } = await this._callApiManagerWithFallBack({
                        functionName: 'getRepositories',
                        functionArgs: { project },
                        projectId: project.id,
                        returnIntegrationId: true
                    });
                    console.info(`[AzureReposServiceMgr][_getRepositories] - got repositories ${results.count} for org: ${project.org} for project: ${project.id}`);
                    for (const repo of results.value) {
                        const owner = `${project.org}/${repo.project.name}`;
                        const { name, isFork, defaultBranch } = repo;
                        const fullRepoName = `${owner}/${name}`;
                        repositories.push({
                            id: repo.id,
                            owner,
                            name,
                            fork: !!isFork,
                            defaultBranch: defaultBranch ? defaultBranch.split('/')[2] : DEFAULT_BRANCH,
                            isPublic: repo.project.visibility === 'public',
                            url: repo.webUrl,
                            integrationId,
                            description: repo.project.description
                        });
                        if (integrationIds.length > 1) {
                            integrationIds.forEach(id => {
                                if (!duplicateRepositoriesByIntegrationId[id]) {
                                    duplicateRepositoriesByIntegrationId[id] = [];
                                }
                                duplicateRepositoriesByIntegrationId[id].push(fullRepoName);
                            });
                        }
                    }
                } catch (err) {
                    this.errorHandler.wrapErrorWithVCSData(err, this.customerName, { ...project }, this.errorHandler.SYNC_REPOSITORIES_PHASE_NAME);
                    if (!ignoreApiErrors) {
                        throw err;
                    }
                    this.errorHandler.setErrorInMonitoringApp(err);
                }
            },
            maxConcurrent: 3
        });
        return { repositories, duplicateRepositoriesByIntegrationId };
    }

    async getRepositories({ customerName, integrationId }) {
        const initResults = await this.init({ customerName });
        if (!initResults) return { totalCount: 0, data: [] };
        const multipleOrgFFValue = await this._isMultipleOrgFeatureFlagEnabled({ customerName });
        if (multipleOrgFFValue && integrationId) { // feature flag ON + has integrationId
            return await this._getRepositoriesByIntegrationId(integrationId);
        }
        const { repositories } = await this._getRepositories();
        if (repositories.length === 0) return { totalCount: 0, data: [] };
        return { totalCount: 1, data: [{ orgName: repositories[0].owner, installationId: null, repositories }] };
    }

    _getFirstIntegrationIdByProject({ projectName, projectId }) {
        const integrationId = this._getIntegrationId({ projectName, projectId });
        if (!integrationId) {
            console.error(`[AzureReposServiceMgr][_getFirstIntegrationIdByProject] - integration id not found for customerName: '${this.customerName}' projectName: ${projectName} or projectId: ${projectId}`);
            throw new Error('could not find integration data');
        }
        return integrationId;
    }

    _getFirstIntegrationIdByFullRepoName({ repositoryName }) {
        let result;
        Object.entries(this.multiIntegrations).some(([integrationId, integrationData]) => {
            if (integrationData.selectedRepositoriesMap[repositoryName]) {
                result = integrationId;
                return true;
            }
            return false;
        });
        if (!result) {
            console.error(`[AzureReposServiceMgr][_getFirstIntegrationIdByFullRepoName] - integration id not found for customerName: '${this.customerName}' repositoryName: ${repositoryName}`);
            throw new Error('could not find integration data');
        }
        return result;
    }

    async getRepository({ customerName, project: projectName, repositoryName }) {
        console.log('[AzureReposServiceMgr][getRepository]: ', { customerName, projectName, repositoryName });
        this._createCustomLabels({ customerName });
        await this.init({ customerName });
        const repo = await this._callApiManagerWithFallBack({
            functionName: 'getRepository',
            functionArgs: { project: projectName, repositoryName },
            projectName
        });
        if (!repo) return {};
        return new Repository({
            id: repo.id,
            owner: projectName,
            name: repo.name,
            fork: !!repo.isFork,
            defaultBranch: repo.defaultBranch ? (repo.defaultBranch.split('/'))[2] : DEFAULT_BRANCH,
            url: repo.webUrl
        });
    }

    async makePullRequest({ customerName, owner, repoName, sourceBranchName, newFiles, commitMessage, commitAuthor, prTitle, prBody, closeSourceBranch, newBranchName }) {
        console.log('makePullRequest', { customerName, owner, repoName, sourceBranchName, newFiles, commitMessage, commitAuthor, prTitle, prBody, closeSourceBranch, newBranchName });
        if (!customerName || !owner || !repoName || !sourceBranchName) {
            throw new Error('Bad params, missing some required params');
        }
        this._createCustomLabels({ customerName });
        if (!newFiles || !Array.isArray(newFiles)) {
            throw new Error('Bad params, missing files [array] param');
        }
        if (!this.customerName) {
            await this.init({ customerName });
        }
        const pullRequestObjResponse = await this._callApiManagerWithFallBack({
            functionName: 'createPullRequest',
            functionArgs: {
                project: owner,
                repositoryName: repoName,
                sourceBranchName,
                files: newFiles,
                commitMessage,
                commitAuthor,
                title: prTitle,
                description: prBody,
                closeSourceBranch,
                newBranchName
            },
            projectName: owner
        });
        return new PullRequest({
            id: pullRequestObjResponse.pullRequestId,
            webUrl: `https://dev.azure.com/${owner}/_git/${repoName}/pullrequest/${pullRequestObjResponse.pullRequestId}`
        }).toJSON();
    }

    async _fetchRepositoryFilesStructure({ customerName, scannerType, repo, extraParameters = {} }) {
        let files = [];
        const defaultValue = { scanPath: null, repository: null };
        const branch = repo.defaultBranch;
        const repoName = repo.name;
        const fullRepoName = `${repo.owner}/${repoName}`;
        const repoPath = `${scannerType}/${customerName}/${repo.owner}/${repoName}/${branch}/${SRC}`;
        console.info(`[AzureReposServiceMgr][_fetchRepositoryFilesStructure] - customerName: '${customerName}' Repository: ${fullRepoName}`, { branch });
        try {
            if (!repo.integrationId) {
                console.error(`[AzureReposServiceMgr][_fetchRepositoryFilesStructure] - integration id not found for customerName: '${customerName}' Repository: ${fullRepoName}`, { branch });
                throw new Error('repo`s integration id is missing');
            }
            files = await this.multiIntegrations[repo.integrationId]?.apiManager.getFiles({ repository: repo, repoId: repo.id, prefix: repoPath });
            files = files.map(file => new File({
                repoId: repo.id,
                path: file.path,
                repo,
                size: file.size,
                branchRef: file.branchRef,
                encoding: file.encoding,
                prefix: repoPath
            }));
            files = await this._removeExcludedFilesByScheme({ customerName, fullRepoName, files });
        } catch (err) {
            if (this._isRateLimitError(err)) {
                console.error(`[AzureReposServiceMgr][_fetchRepositoryFilesStructure] - customerName: '${customerName}', Rate limit error`, err);
                throw this._createRateLimitError({ customerName });
            }
            this.errorHandler.wrapErrorWithVCSData(err, customerName, { owner: repo.owner, name: repo.name, repoId: repo.id, prefix: repoPath }, this.errorHandler.GET_REPOSITORIES_FILES_STRUCTURE_PHASE_NAME);
            console.error(`[AzureReposServiceMgr][_fetchRepositoryFilesStructure] - customerName: ${customerName} failed to fetch repository '${repoName}' structure, repository will ignored`, err);
            this.errorHandler.setErrorInMonitoringApp(err);
            return defaultValue;
        }
        if (!Array.isArray(files) || files.length === 0) {
            console.info(`[AzureReposServiceMgr][_fetchRepositoryFilesStructure] - customerName: '${customerName}', There are no valid files for scan in repository`, { customerName, fullRepoName });
            return defaultValue;
        }
        console.log(`[AzureReposServiceMgr][getRepositoriesFilesStructure] - customerName: '${customerName}', repository has ${repoName} '${files.length}' files`);
        return {
            scanPath: { owner: repo.owner, name: repo.name, defaultBranch: branch, path: repoPath, isPublic: repo.public, url: repo.url, repoId: repo.id },
            repository: { name: repo.name, owner: repo.owner, public: repo.isPublic, url: repo.url, branch, repoPath, files }
        };
    }

    async getFileContent(file) {
        const fullRepoName = `${file.repo.owner}/${file.repo.name}`;
        const fileMsg = `file ${file.path} for repo ${fullRepoName}`;
        try {
            const fileContent = await this._callApiManagerWithFallBack({
                functionName: 'getFileContent',
                functionArgs: { owner: file.repo.owner, repositoryName: file.repo.name, sha: file.branchRef, filePath: file.path },
                projectName: file.repo.owner
            });
            if (!fileContent) {
                // suppressed according to Yoni
                // eslint-disable-next-line no-throw-literal
                throw `${fileMsg} has no content`;
            }
            return fileContent;
        } catch (error) {
            if (!error) return;

            if (error === `${fileMsg} has no content`) {
                console.info(error);
            } else {
                const { response } = error;
                if (!response) return;
                const { status, statusText, data } = response;
                if ((status === 404 && statusText.includes('Not Found') && data.typeKey.includes('GitItemNotFoundException'))) {
                    console.error(`failed to get ${fileMsg}, message: ${data.message}`);
                } else {
                    throw new Error(error);
                }
            }
        }
    }

    normalizeFilesForSave(files) {
        return files.map(file => ({
            repoOwner: file.repo.owner,
            repoName: file.repo.name,
            branch: file.repo.defaultBranch,
            content: file.content,
            encoding: file.encoding,
            path: file.path
        }));
    }

    async _fetchRepositories({ customerName }) {
        return await this._getRepositories(true);
    }

    async _getFilesStructureParameters({ customerName, repositories }) {
        const maxConcurrent = 10;
        return { maxConcurrent, chunkSize: CHUNK_SIZE, extraParameters: {} };
    }

    _getShouldCloneValue({ fileLength }) {
        return fileLength > config.downloadIndividualFilesThreshold;
    }

    async downloadChunkContentsAndUploadToBucket({ chunk, customerName, scannerType }) {
        const { shouldClone } = chunk[0];
        console.log(`[AzureReposServiceMgr][downloadChunkContentsAndUploadToBucket] - should clone chunck: ${shouldClone}`);
        if (shouldClone) {
            await this.cloneReposAndUploadFilesToS3({ chunk, customerName, scannerType, shouldPersistFiles });
        } else {
            await this.fetchIndividualFilesContentsAndUploadToBucket({ chunk, customerName, scannerType, maxConcurrent: 5 });
        }
    }

    async _generateBCFullWebhookPath() {
        const vcsSSmMgrInstance = vcsSSmMgr.getInstance();
        const globalRedirectUrl = await vcsSSmMgrInstance.getGlobalRedirectUrl(this.module);
        return `${globalRedirectUrl}${config.webHookRelativePath}`;
    }

    _getHooksArrayByIntegrationId(integrationId) {
        return this.multiIntegrations[integrationId]?.orgs;
    }

    async _getHooksFromVCS(entity) {
        let firstOrganizationIntegration;
        for (const [integrationId, integrationData] of Object.entries(this.multiIntegrations)) {
            if (integrationData.orgs.find(org => org === entity)) {
                firstOrganizationIntegration = integrationId;
                break;
            }
        }
        if (firstOrganizationIntegration) return this.multiIntegrations[firstOrganizationIntegration].apiManager.getHooks({ org: entity });
    }

    _filterHooks({ hooks = [], BC_FULL_WEBHOOK_PATH }) {
        return hooks.filter(orgHook => orgHook.consumerInputs.url === BC_FULL_WEBHOOK_PATH && (orgHook.eventType === createEventType || orgHook.eventType === updateEventType));
    }

    async _updateVCSHooks({ hooks, entity, repositories, vcsRepositories, BC_FULL_WEBHOOK_PATH, integrationId }) {
        const stats = {};
        const relevantRepositories = vcsRepositories.filter(repo => repo.owner.startsWith(entity));
        const relevantHooks = this._filterHooks({ hooks, BC_FULL_WEBHOOK_PATH });
        await Promise.all(relevantRepositories.map(async relevantRepo => {
            const fullRepoName = `${relevantRepo.owner}/${relevantRepo.name}`;
            const integrationData = this.multiIntegrations[integrationId];
            const relevantRepoHooks = relevantHooks.filter(hook => hook.publisherInputs.repository === relevantRepo.id);
            const isRepoChosen = repositories.includes(fullRepoName);
            const isRepoGotCreatePRWebhook = relevantRepoHooks.find(hook => hook.type === createEventType);
            const isRepoGotUpdatePRWebhook = relevantRepoHooks.find(hook => hook.type === updateEventType);
            if (isRepoChosen) {
                if (isRepoGotCreatePRWebhook && isRepoGotUpdatePRWebhook) {
                    // the repo already has bc hooks and user wants to subscribe
                    stats[fullRepoName] = BC_HOOKS_STATUS.ALREADY_EXIST;
                }
                const projectId = integrationData.projects.find(proj => relevantRepo.owner.endsWith(`/${proj.name}`)).id;
                if (!isRepoGotCreatePRWebhook) {
                    await integrationData.apiManager.setHook({
                        org: entity,
                        publisherId: 'tfs',
                        eventType: createEventType,
                        consumerId: 'webHooks',
                        consumerActionId: 'httpRequest',
                        publisherInputs: { repository: relevantRepo.id, projectId },
                        consumerInputs: { url: BC_FULL_WEBHOOK_PATH }
                    });
                    stats[fullRepoName] = BC_HOOKS_STATUS.CREATED;
                }
                if (!isRepoGotUpdatePRWebhook) {
                    await integrationData.apiManager.setHook({
                        org: entity,
                        publisherId: 'tfs',
                        eventType: updateEventType,
                        consumerId: 'webHooks',
                        consumerActionId: 'httpRequest',
                        publisherInputs: { repository: relevantRepo.id, projectId },
                        consumerInputs: { url: BC_FULL_WEBHOOK_PATH }
                    });
                    stats[fullRepoName] = BC_HOOKS_STATUS.CREATED;
                }
            } else if (relevantRepoHooks.length && !isRepoChosen) { // the repo already has bc hooks and user wants to unsubscribe
                await Promise.all(relevantRepoHooks.map(async hook => {
                    await integrationData.apiManager.deleteHook({ org: entity, subscriptionId: hook.id });
                }));
                stats[fullRepoName] = BC_HOOKS_STATUS.DELETED;
            } else if (!relevantHooks.length && !isRepoChosen) { // no bc hooks for that repository and user wants to unsubscribe
                stats[fullRepoName] = BC_HOOKS_STATUS.DO_NOTHING;
            }
        }));
        return stats;
    }

    async handlePullRequest({ eventType, repoSettingSchema, repositoryFullName, org, project, projectId, name, repoId, fromBranch, intoBranch, pr, commit, prTitle, author, isNewCommitToPR, domain, isPrisma, enforcementRulesEnabled }) {
        this._createCustomLabels({ customerName: this.customerName });
        console.info(`handlePullRequest for customer: ${this.customerName} - eventType: ${eventType} repositoryFullName: ${repositoryFullName} org: ${org} project: ${project} name: ${name}`);
        const repoOwner = `${org}/${project}`;
        if (!domain) {
            throw new Error('could not get detailsDomain for customer', this.customerName);
        }
        if (eventType === webhookConf.eventTypes.PR_CREATED || eventType === webhookConf.eventTypes.PR_UPDATED) {
            // Check if the commit already exists
            const existingRun = await cicdRemoteLambda.invoke('CICD/getRun', {
                repositoryName: name,
                repositoryOwner: repoOwner,
                source: SOURCE_TYPES.AZURE_REPOS,
                customerName: this.customerName,
                fromBranch,
                intoBranch,
                pr,
                commit
            });
            console.log('Existing run: ', existingRun);

            if (fromBranch.startsWith(BRANCH_PREFIXES.PLATFORM_PR_BRANCH_PREFIX)) {
                await this.createPlatformPREntity(({ fromBranch, intoBranch, customerName: this.customerName, owner: repoOwner, source: SOURCE_TYPES.AZURE_REPOS, repositoryName: name, number: pr, title: prTitle, author }));
                return;
            }
            const firstIntegrationIdForProject = this._getFirstIntegrationIdByProject({ projectName: repoOwner });
            if (!existingRun) {
                const azureReposCodeReviewIntegration = new AzureReposCodeReviewIntegration({
                    apiManager: this.multiIntegrations[firstIntegrationIdForProject].apiManager,
                    sourceType: SOURCE_TYPES.AZURE_REPOS,
                    customerName: this.customerName,
                    repository: name,
                    owner: repoOwner,
                    pr,
                    prTitle,
                    commit,
                    fromBranch,
                    intoBranch,
                    author,
                    repoSettingSchema,
                    domain,
                    isPrisma,
                    org,
                    projectId,
                    repoId,
                    isNewCommitToPR,
                    enforcementRulesEnabled
                });

                await azureReposCodeReviewIntegration.start();
            }
        }
    }

    async getChangedPRFiles({ customerName, owner, repo, pullNumber, branchName, commit, org, projectId, repoId }) {
        this._createCustomLabels({ customerName });
        console.info('got azure getChangedPRFiles request', { customerName, owner, repo, pullNumber, branchName, commit, org, projectId, repoId });
        await this.init({ customerName });
        let scanPaths = [];
        const fullRepoName = `${owner}/${repo}`;
        const { results, integrationId } = await this._callApiManagerWithFallBack({
            functionName: 'getCommitChanges',
            functionArgs: { org, projectId, repoId, commit },
            projectName: owner,
            returnIntegrationId: true
        });
        const changes = this.getChangedFilesPathsAndDiffs(results.changes);

        if (changes.length === 0) {
            console.info('pull request doesn\'t have relevant files');
            return { scanPaths };
        }
        const repoSettingSchema = await settingsMgrApiLambda.invoke('vcsSettings/getScheme', { customerName, fullRepoName });
        const filteredFromSchemaFiles = removeExcludedFiles({ repoSettingSchema, files: changes, pathInFile: 'path', fullRepoName });
        if (!filteredFromSchemaFiles || !filteredFromSchemaFiles.length) {
            console.info('all the changed files where excluded');
            return { scanPaths };
        }

        console.log('getChangedPRFiles:filteredFromSchemaFiles', filteredFromSchemaFiles);
        const pathsOfChangedFiles = filteredFromSchemaFiles.reduce((paths, changeObj) => {
            paths.push(changeObj.path);
            return paths;
        }, []);

        // this instance of encodeURIComponent is used for the S3 path, so we do not convert the spaces to _, otherwise
        // we will end up with duplicates in S3
        const prefix = `${SCANNER_TYPE}/${customerName}/${owner}/${encodeURIComponent(repo)}/PRs/${pullNumber}/${commit}/${SRC}`;

        await this.getFilesAndUploadToS3({
            org,
            projectId,
            repoId,
            filesPaths: pathsOfChangedFiles,
            prefix,
            commit,
            customerName,
            integrationId
        });
        const patchLinesToFileMapping = this.createPatchLinesToFileMapping({ files: filteredFromSchemaFiles });
        scanPaths = [{ owner, name: repo, path: prefix, public: true }];
        return { scanPaths, patchLinesToFileMapping };
    }

    async cloneRepository({ fullRepoName, customerName, reposFolderPath }) {
        if (!this.customerName) {
            await this.init({ customerName });
        }
        const { owner } = this._extractOwnerAndRepoNameFromFullRepoName(fullRepoName);
        const firstIntegrationIdForProject = this._getFirstIntegrationIdByProject({ projectName: owner });
        return this.multiIntegrations[firstIntegrationIdForProject].apiManager.cloneRepo({ fullRepoName, customerName, reposFolderPath });
    }

    async getGitCloneString({ customerName, repoOwner, repoName }) {
        await this.init({ customerName });
        console.log('getGitCloneString: ', { customerName, repoOwner, repoName });
        const firstIntegrationIdForProject = this._getFirstIntegrationIdByFullRepoName({ repositoryName: `${repoOwner}/${repoName}` });
        return {
            gitCloneString: this.multiIntegrations[firstIntegrationIdForProject].apiManager.createGitCloneString({
                repoOwnerAndOrganization: repoOwner,
                repoName,
                isShallowClone: false
            })
        };
    }

    createPatchLinesToFileMapping({ files }) {
        console.log('createPatchLinesToFileMapping', files);
        const mapping = [];
        if (files && files.length) {
            files.forEach(file => {
                const lines = [[1, 10000]];
                mapping.push({ path: file.path, lines });
            });
        }
        console.log('createPatchLinesToFileMapping:mapping', mapping);
        return mapping;
    }

    getChangedFilesPathsAndDiffs(changes) {
        if (!changes || !changes.length) {
            return [];
        }
        const filesThatHaveChanged = changes.reduce((files, changeObj) => {
            if (changeObj.changeType !== 'delete' && changeObj.changeType !== 'rename' && changeObj.changeType !== 'none') {
                if (this.isValidFileForScan(changeObj.item.path)) {
                    files.push({
                        path: changeObj.item.path.startsWith('/') ? changeObj.item.path.substring(1) : changeObj.item.path,
                        url: changeObj.item.url,
                        objectId: changeObj.item.objectId
                    });
                }
            }
            return files;
        }, []);
        return filesThatHaveChanged;
    }

    async getFilesAndUploadToS3({ org, projectId, repoId, filesPaths, prefix, commit, customerName, integrationId }) {
        console.info(`getting and uploading ${filesPaths.length} files...`);
        const files = await promiseAllWithRateLimit({
            arr: filesPaths,
            maxConcurrent: 50,
            callback: (async path => {
                const file = new File({ path, encoding: config.encoding });
                const fileContentParams = {
                    org,
                    projectId,
                    repoId,
                    filePath: path,
                    commit
                };
                try {
                    file.content = await this.multiIntegrations[integrationId].apiManager.getFileContentFromCommit(fileContentParams);
                } catch (error) {
                    console.error('Error: Azure getFilesAndUploadToS3 failed to get file content', JSON.stringify(error));
                    this.errorHandler.wrapErrorWithVCSData(error, customerName, fileContentParams);
                    throw error;
                }
                await file.save({ prefix, bucket: SCAN_RESULTS_BUCKET });
                return file;
            })
        });
        console.info(`successfully got and uploaded ${files.length} files`);
        return files;
    }

    async _updatePrCheckStatus({ customerName, owner, repo, state, pullNumber, detailsURL, prCheckTitle, projectId, description, manuallyPassed = false }) {
        console.log('[AzureReposServiceMgr][updatePrCheckStatus]', { customerName, owner, projectId, repo, pullNumber, detailsURL, prCheckTitle, state });
        try {
            const orgAndProjectName = owner.split('/');
            const org = orgAndProjectName[0];
            const projectName = orgAndProjectName[1];
            const chosenProjectId = projectId || this._getProjectIdByProjectName({ projectName, org });
            if (!chosenProjectId) {
                throw new Error(`[AzureReposServiceMgr][updatePrCheckStatus] - could not find project id for project ${org}/${projectName}`);
            }
            console.log(`[AzureReposServiceMgr][updatePrCheckStatus] chosenProjectId: ${chosenProjectId}`);
            await this._callApiManagerWithFallBack({
                functionName: 'setPullRequestStatus',
                functionArgs: {
                    org,
                    projectId: chosenProjectId,
                    repoId: repo,
                    pr: pullNumber,
                    data: {
                        context: {
                            genre: prCheckTitle,
                            name: prCheckTitle
                        },
                        description,
                        state,
                        targetUrl: detailsURL
                    }
                },
                projectId: chosenProjectId,
                projectName
            });
            return { result: 'success' };
        } catch (e) {
            console.error('[AzureReposServiceMgr][updatePrCheckStatus] failed to update pr check status', e);
            throw new Error('[AzureReposServiceMgr][updatePrCheckStatus] failed to update pr check status');
        }
    }

    async handlePullRequestCompleted({ customerName, owner, repository, pullNumber, isMerged, fromBranch }) {
        this._createCustomLabels({ customerName });
        console.info('handlePullRequestCompleted', { customerName, owner, repository, pullNumber, isMerged });
        await this.init({ customerName });
        try {
            const suppressedResources = await cicdRemoteLambda.invoke('CICD/handleMergedCICDRun', { customerName, owner, repository, pullNumber, shouldGetSuppressedResources: isMerged });
            if (isMerged && suppressedResources && (suppressedResources.cves.length || suppressedResources.violationResources.length)) {
                await suppressViolationsUponMergeToDefaultBranch({
                    accountId: `${owner}/${repository}`,
                    customerName,
                    violationResources: suppressedResources.violationResources,
                    cves: suppressedResources.cves
                });
            }
            await this.updatePREntities({ isMerged, fromBranch, pullNumber, owner, repository, customerName });
            console.info('handlePullRequestCompleted:done');
        } catch (e) {
            console.error(e);
            throw new Error('failed to handle close merge request');
        }
    }

    async updatePREntities({ isMerged, fromBranch, pullNumber, owner, repository, customerName }) {
        const status = isMerged ? PR_STATUS.MERGED : PR_STATUS.CLOSED;
        await this.updatePREntityStatus({ fromBranch, number: pullNumber, owner, repositoryName: repository, customerName, status, source: SOURCE_TYPES.AZURE_REPOS });
    }

    async commitAndPush({ customerName, owner, repoName, sourceBranchName, newFiles }) {
        if (!customerName || !owner || !repoName || !sourceBranchName) throw new Error('Bad params, missing some required params');
        this._createCustomLabels({ customerName });
        if (!newFiles || !Array.isArray(newFiles)) throw new Error('Bad params, missing files [array] param');
        await this.init({ customerName });
        const commitAndPushResponse = await this._callApiManagerWithFallBack({
            functionName: 'commitAndPush',
            functionArgs: { project: owner, repositoryName: repoName, branch: sourceBranchName, files: newFiles },
            projectName: owner
        });
        console.info(`commitAndPushResponse=\n${JSON.stringify(commitAndPushResponse)}`);
        return commitAndPushResponse;
    }

    async createRelevantComments({ customerName, violations, sourceId, prData, repoConf, repositoryRule, module }) {
        console.log('createRelevantComments', { customerName, violations, sourceId, prData, repoConf, repositoryRule, module });
        const comments = [];
        await Promise.all(violations.map(async violation => {
            const [filePath, resource] = violation.resource_id.split(':');
            if (violation.violation_status === VIOLATION_STATUSES.OPEN
                && (
                    (!repositoryRule && isViolationRelevant({ violationConfiguration: { severity: violation.severity, incidentId: violation.violation_id }, repoConf }))
                    || (repositoryRule
                        && isViolationRelevantByEnforcementRules({ repositoryRule, violationId: violation.violation_id, severity: violation.severity, customViolation: violation.isCustom, thresholdName: THRESHOLD_SEVERITY_NAMES.COMMENTS_BOT_THRESHOLD }))
                )
                && !await checkIsSuppressed({ violationId: violation.violation_id, resourceId: violation.resource_id, customerName, sourceId })) {
                comments.push({
                    parentCommentId: 0,
                    content: getCommentMarkdownText({
                        title: violation.title,
                        severity: violation.severity,
                        branch: prData.branch,
                        resource,
                        incidentId: violation.violation_id,
                        fix: violation.howToFix,
                        desc: violation.description,
                        bench: violation.benchmarks,
                        lines: violation.metadata_lines,
                        resourcePath: filePath,
                        fullRepoName: sourceId,
                        commit: violation.commit, // if fixed it true then it is promised that commit is exist and not null
                        commitMessage: violation.commitMessage,
                        dependantResources: [],
                        vcsType: SOURCE_TYPES.AZURE_REPOS,
                        module
                    }),
                    commentType: 1
                });
            }
        }));
        console.log('createRelevantComments:comments', { comments, VIOLATION_SEVERITIES_ORDER });
        comments.sort((violation1, violation2) => VIOLATION_SEVERITIES_ORDER[violation1.severity] > VIOLATION_SEVERITIES_ORDER[violation2.severity] ? 1 : -1);
        console.log('createRelevantComments:sorted comments', comments);
        comments.unshift({ parentCommentId: 0, content: TEXT_CONFIG[module].prComments.getPRReviewDescription(), commentType: 1 });
        console.log('createRelevantComments:fullComments', comments);
        return comments;
    }

    async createOrUpdatePRComments({ customerName, sourceId, repoConf, prData, violations, isPartialScan, patchLinesToFileMapping, module, repositoryRule }) {
        console.log('createOrUpdatePRComments:', { customerName, sourceId, repoConf, prData, violations, isPartialScan, patchLinesToFileMapping, module, repositoryRule });
        this._createCustomLabels({ customerName });
        if (!violations.length) return [];
        await this.init({ customerName });
        const commentsToPost = await this.createRelevantComments({ customerName, violations, sourceId, prData, repoConf, repositoryRule, module });
        console.log('createOrUpdatePRComments:commentsToPost', { customerName }, commentsToPost);
        const params = { org: prData.org, projectId: prData.projectId, repoId: prData.repoId, pr: prData.pullNumber, comments: [commentsToPost[0]] };
        console.log('createOrUpdatePRComments:params', { customerName }, params);
        const { results, integrationId } = await this._callApiManagerWithFallBack({
            functionName: 'createPRThread',
            functionArgs: params,
            projectId: prData.projectId,
            returnIntegrationId: true
        });
        let threadRes = results;
        console.log('createOrUpdatePRComments:threadRes', { customerName }, threadRes);
        // below is a workaround since Azure API throws and error when trying to post multiple comments at the thread creation,
        // so we create a thread with one comment and then update the thread with the rest of the comments
        if (commentsToPost.length > 1) {
            params.id = threadRes.id;
            params.comments = commentsToPost.slice(1);
            console.log('createOrUpdatePRComments:params2', { customerName }, params);
            threadRes = await this.multiIntegrations[integrationId].apiManager.updatePRThread(params);
            console.log('createOrUpdatePRComments:threadUpdateRes', { customerName }, threadRes);
        }
        const result = violations.map((comment, commentId) => ({ violationId: comment.violation_id, resourceId: comment.resource_id, commentId: commentId + 2 }));
        // the +2 is because comments ids in azure starts from 1 and the first comment is just the thread description so we're skipping it
        console.log('createOrUpdatePRComments:result', { customerName }, 'result', result);
        return result;
    }

    async getProfile({ customerName }) {
        console.log(`[azureReposServiceMgr][getProfile] - get profiles for customer ${customerName}`);

        let profile;
        try {
            const initResult = await this.init({ customerName });
            if (!initResult) throw Error(`failed to init for customer ${customerName}`);
            const profiles = {};

            // eslint-disable-next-line guard-for-in
            for (const integrationId in this.multiIntegrations) {
                try {
                    console.info(`getting profile for customer: ${customerName} and integration id ${integrationId}`);
                    profile = await this.multiIntegrations[integrationId].apiManager.getProfile();
                    if (profile.id) profiles[integrationId] = profile;
                } catch (e) {
                    console.error(`failed to get profile for customer ${customerName} and integration id ${integrationId}`);
                }
            }

            return profiles;
        } catch (err) {
            throw new Error(`failed for customer ${customerName}`, err);
        }
    }

    _getProjectIdByProjectName({ projectName, org }) {
        for (const [_, integrationData] of Object.entries(this.multiIntegrations)) {
            const project = integrationData.projects.find(item => `${item.org}/${item.name}` === `${org}/${projectName}`);
            return project?.id;
        }
    }
}

module.exports = { AzureReposServiceMgr };
