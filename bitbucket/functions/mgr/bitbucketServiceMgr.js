const AWS = require('aws-sdk');
const { execSync } = require('child_process');
const fs = require('fs');

const s3 = new AWS.S3();

const RemoteLambda = require('@bridgecrew/nodeUtils/remoteLambda/invoke');
const { THRESHOLD_SEVERITY_NAMES, PR_STATUS } = require('@bridgecrew/dal-layer');
const Repository = require('@bridgecrew/nodeUtils/models/VersionControl/repository');
const File = require('@bridgecrew/nodeUtils/models/VersionControl/file');
const PullRequest = require('@bridgecrew/nodeUtils/models/VersionControl/pullRequest');
const { promiseAllWithRateLimit } = require('@bridgecrew/nodeUtils/common/promiseAllWithRateLimit');
const {
    suppressViolationsUponMergeToDefaultBranch, cleanDeletedFiles, checkIsSuppressed, handleYorClosedMergedPR, convertSeverityForPrisma,
    handleRevokedVcs
} = require('@bridgecrew/nodeUtils/vcs/utils');
const { isViolationRelevant, getVCSRepoConfIfFeatureEnabled, removeExcludedFiles } = require('@bridgecrew/nodeUtils/vcs/repoSettingSchema');
const { SOURCE_TYPES, BITBUCKET_CHECK_STATUSES, BITBUCKET_CHECK_MESSAGES, MODULE_TYPE } = require('@bridgecrew/nodeUtils/models/Enums');
const { TEXT_CONFIG } = require('@bridgecrew/nodeUtils/vcs/uiTextConfig');
const vcsSSmMgr = require('@bridgecrew/vcs-ssm-mgr');
const { isViolationRelevantByEnforcementRules } = require('@bridgecrew/vcs-utils');
const { BitbucketValidator } = require('@bridgecrew/vcs-classes');
const { BRANCH_PREFIXES } = require('../../../utils/index');

const SOURCE_TYPE = SOURCE_TYPES.BITBUCKET;
const CHUNK_SIZE = 10000;
const trackingRemoteLambda = new RemoteLambda(process.env.TRACKING_SERVICE_LAMBDA);
const customersRemoteLambda = new RemoteLambda(process.env.CUSTOMERS_API_LAMBDA);
const settingsMgrApiLambda = new RemoteLambda(process.env.SETTINGS_MGR_API_LAMBDA);
const cicdRemoteLambda = new RemoteLambda(process.env.CICD_API_LAMBDA_NAME);
const enforcementRulesApiLambda = new RemoteLambda(process.env.ENFORCEMENT_RULES_API_LAMBDA);
const shouldPersistFiles = process.env.PERSIST_FILES !== 'false';

const { SCAN_RESULTS_BUCKET, SCANNER_CHECKOV_LAMBDA_NAME, CHECKOV_SETUP_LAMBDA_NAME } = process.env;

const TokenManager = require('./apis/tokenManager');
const ApiManager = require('./apis/apiManager');
const BitbucketCodeReviewIntegration = require('./CodeReview/index');
const BaseVCSClass = require('../../../models/baseClass');

const config = require('./conf/config').serviceManager;

const SRC = 'src';

const qualifier = process.env.USE_PROVISIONED_CONCURRENCY === 'true' ? process.env.PROVISIONED_ALIAS_STRING : process.env.LATEST_VERSION_STRING;

class BitbucketServiceMgr extends BaseVCSClass {
    /**
     * this.apiManager: instance of ApiManager
     * this.workspaces: Array of String
     * this.selectedRepositories: Array of String
     * this.customerName: String
     */
    constructor() {
        super(SOURCE_TYPES.BITBUCKET);
        this.apiManager = null;
        this.workspaces = null;
        this.customerName = null;
        this.permittedAccounts = [];
        this.selectedRepositories = []; // the repositories that stored on the integration table
        this.cleanDeletedFiles = cleanDeletedFiles;
    }

    async getGitCloneString({ customerName, repoOwner, repoName }) {
        this._createCustomLabels({ customerName });
        this.customerName = customerName;
        await this.init({ customerName });
        const tokenData = await this.tokenManager.getTokenData();
        const accessToken = tokenData.access_token;
        if (accessToken) {
            return { gitCloneString: `https://x-token-auth:${accessToken}@bitbucket.org/${repoOwner}/${repoName}.git` };
        }

        return { gitCloneString: null };
    }

    _isRateLimitError(err) {
        const { message, statusCode } = this._extractDetailsFromError(err);
        return statusCode === 429 || (message && message.includes('Rate limit')); // Rate limit for this resource has been exceeded
    }

    async _getRepositories(ignoreApiErrors = false) {
        let repositories = [];
        this.errorHandler.errorPhaseIncreaseTotal(this.errorHandler.SYNC_REPOSITORIES_PHASE_NAME, this.workspaces.length);
        // eslint-disable-next-line no-restricted-syntax
        for (const workspace of this.workspaces) {
            try {
                console.info(`getting repositories for workspace: ${workspace}`);
                const workspaceRepositories = await this.apiManager.getRepositories({ workspace });
                console.info(`got repositories ${workspaceRepositories.length} for workspace: ${workspace}`);
                repositories = repositories.concat(workspaceRepositories);
            } catch (err) {
                this.errorHandler.wrapErrorWithVCSData(err, this.customerName, { workspace }, this.errorHandler.SYNC_REPOSITORIES_PHASE_NAME);
                if (!ignoreApiErrors) {
                    throw err;
                }
                this.errorHandler.setErrorInMonitoringApp(err);
            }
        }

        return repositories.map((repo) => new Repository(
            {
                id: repo.uuid,
                owner: repo.workspace.slug,
                name: repo.slug,
                fork: !!repo.parent,
                defaultBranch: repo.mainbranch ? repo.mainbranch.name : config.defaultBranch,
                isPublic: !repo.is_private,
                url: repo.links.html.href,
                description: repo.description
            }
        ));
    }

    async _getFilesStructureParameters({ customerName, repositories }) {
        const maxConcurrent = 1;
        return { maxConcurrent, chunkSize: CHUNK_SIZE, extraParameters: {} };
    }

    async _fetchRepositoryFilesStructure({ customerName, scannerType, repo, extraParameters }) {
        let files = [];
        let branchRef = null;
        const defaultValue = { scanPath: null, repository: null };
        const fullRepoName = `${repo.owner}/${repo.name}`;
        const branch = repo.defaultBranch;
        const repoPath = `${scannerType}/${customerName}/${repo.owner}/${repo.name}/${repo.defaultBranch}/${SRC}`;
        console.info(`[BitbucketServiceMgr][_fetchRepositoryFilesStructure] - Repository: ${fullRepoName}`, { branch });
        try {
            branchRef = await this.apiManager.getLatestBranchReference({ workspace: repo.owner, repositoryName: repo.name, branchName: repo.defaultBranch });
            if (!branchRef) {
                console.info(`[BitbucketServiceMgr][_fetchRepositoryFilesStructure] - branchRef doesn't exist for ${fullRepoName} - it's empty repository`);
                return defaultValue;
            }
            console.log(`[BitbucketServiceMgr][_fetchRepositoryFilesStructure] - successfully got latest branch reference: ${branchRef} for branch: ${repo.defaultBranch}`);
            files = await this.apiManager.getFiles({ workspace: repo.owner, repositoryName: repo.name, nodeHash: branchRef });
            files = files.map(file => new File({
                repoId: repo.id,
                path: file.path,
                repo,
                size: file.size,
                branchRef,
                encoding: config.encoding,
                prefix: repoPath
            }));
            files = await this._removeExcludedFilesByScheme({ customerName, fullRepoName, files });
        } catch (err) {
            if (this._isRateLimitError(err)) {
                console.error(`[BitbucketServiceMgr][_fetchRepositoryFilesStructure] - Rate limit error for customer ${customerName}`, err);
                throw this._createRateLimitError({ customerName });
            }
            this.errorHandler.wrapErrorWithVCSData(err, customerName, { owner: repo.owner, name: repo.name, repoId: repo.id, branchRef }, this.errorHandler.GET_REPOSITORIES_FILES_STRUCTURE_PHASE_NAME);
            console.error(`[BitbucketServiceMgr][_fetchRepositoryFilesStructure] - failed to fetch repository '${repo.name}' structure, repository will ignored`, err);
            this.errorHandler.setErrorInMonitoringApp(err);
            return defaultValue;
        }
        if (!Array.isArray(files) || files.length === 0) {
            console.info('[BitbucketServiceMgr][_fetchRepositoryFilesStructure] - There are no valid files for scan in repository', { customerName, fullRepoName });
            return defaultValue;
        }
        console.log(`[BitbucketServiceMgr][_fetchRepositoryFilesStructure] - repository has ${repo.name} '${files.length}' files`);
        return {
            scanPath: { owner: repo.owner, name: repo.name, defaultBranch: branch, path: repoPath, public: repo.isPublic, url: repo.url, repoId: repo.id },
            repository: { name: repo.name, owner: repo.owner, public: repo.isPublic, url: repo.url, branch, repoPath, files }
        };
    }

    _getShouldCloneValue({ fileLength }) {
        return fileLength > config.downloadIndividualFilesThreshold;
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

    async downloadChunkContentsAndUploadToBucket({ chunk, customerName, scannerType }) {
        const { shouldClone } = chunk[0];
        if (shouldClone) {
            await this.cloneReposAndUploadFilesToS3({ chunk, customerName, scannerType, shouldPersistFiles });
        } else {
            await this.fetchIndividualFilesContentsAndUploadToBucket({ chunk, customerName, scannerType, maxConcurrent: 50 });
        }
    }

    async cloneRepository({ fullRepoName, customerName, reposFolderPath }) {
        return this.apiManager.cloneRepo({ fullRepoPath: fullRepoName, customerName, reposFolderPath });
    }

    async getFileContent(file) {
        return await this.apiManager.getFileContent({
            workspace: file.repo.owner,
            repositoryName: file.repo.name,
            nodeHash: file.branchRef,
            filePath: file.path
        });
    }

    async _getWorkspaces() {
        const [workspacesResponse, userRepositoriesPermissionList] = await Promise.all([this.apiManager.getWorkspaces(), this.apiManager.getUserRepositoriesList()]);

        const workspaces = workspacesResponse.map(workspace => workspace.slug);
        console.info(`workspaces: ${workspaces}`);

        let additionalWorkspaces = userRepositoriesPermissionList.map(ur => ur.repository && ur.repository.full_name && ur.repository.full_name.split('/')[0]);
        additionalWorkspaces = additionalWorkspaces.filter(a => a);
        console.info(`additionalWorkspaces: ${additionalWorkspaces}`);

        const totalWorkspaces = [...new Set([...workspaces, ...additionalWorkspaces])];
        console.info(`totalWorkspaces: ${totalWorkspaces}`);

        return totalWorkspaces;
    }

    async isTokenRevoked({ customerNames }) {
        const revokedArr = [];
        for (const customerName in customerNames) {
            if (customerName) {
                try {
                    await this.init({ customerName: customerNames[customerName] });
                } catch (e) {
                    revokedArr.push({ customerName, err: JSON.stringify(e) });
                }
            }
        }

        return revokedArr;
    }

    async _apiManagerInitialization({ refreshToken, module }) {
        const vcsSSmMgrInstance = vcsSSmMgr.getInstance();
        const clientId = await vcsSSmMgrInstance.getClientId(SOURCE_TYPES.BITBUCKET, module);
        const secret = await vcsSSmMgrInstance.getClientSecret(SOURCE_TYPES.BITBUCKET, module);
        this.apiGatewayUrl = await vcsSSmMgrInstance.getGlobalRedirectUrl(module);
        this.tokenManager = new TokenManager({ refreshToken, clientId, secret, module });
        await this.tokenManager.init();
        try {
            const tokenData = await this.tokenManager.getTokenData(true);
            const accessToken = tokenData.access_token;
            // todo: check if we need to update the integration table??? is the refresh_token is temporary
            this.apiManager = new ApiManager({ accessToken });
        } catch (e) {
            console.log(`[BitbucketServiceMgr][_apiManagerInitialization] - token revoked for customer ${this.customerName}`, this.customerName);
            throw e;
        }
    }

    async init({ customerName, permittedAccounts }) {
        this.customerName = customerName;
        this.permittedAccounts = permittedAccounts;
        const integrations = await this._getIntegrationData({ customerName });
        console.log(`[BitbucketServiceMgr][init] - Bitbucket integrations for ${customerName} are: ${JSON.stringify(integrations)}`);
        if (integrations && integrations.length > 0) {
            const integration = integrations[0];
            const { params, integration_details: integrationDetails } = integration;
            this.module = params.module;
            await this._apiManagerInitialization({ refreshToken: params.refresh_token, module: params.module });
            this.workspaces = await this._getWorkspaces();
            this.selectedRepositories = params.repositories;
            this.integrationId = integration.id;
            this.reposSelectionType = params.reposSelectionType;
            this.updatedByPcUser = integrationDetails.updatedByPcUser;
            this.integrationCache = integration;
            this.userName = params.username;
            console.info('[BitbucketServiceMgr][init] - successfully finished', {
                customerName,
                module: this.module,
                workspaces: this.workspaces
            });
            this.ready = true;
            return true;
        }
        console.error('[BitbucketServiceMgr][init] - There are no available integrations for Bitbucket', { customerName });
        return false;
    }

    async getRepository({ customerName, workspace, repositoryName }) {
        if (!this.customerName) {
            await this.init({ customerName });
        }
        const repositoryResponse = await this.apiManager.getRepository({ workspace, repositoryName });
        return new Repository({
            id: repositoryResponse.uuid,
            owner: repositoryResponse.workspace.slug,
            name: repositoryResponse.slug,
            fork: !!repositoryResponse.parent,
            defaultBranch: repositoryResponse.mainbranch ? repositoryResponse.mainbranch.name : config.defaultBranch,
            url: repositoryResponse.links.html.href
        });
    }

    async getRepositories({ customerName }) {
        console.info(`get repositories for customer: ${customerName}`);
        if (!this.customerName) {
            await this.init({ customerName });
        }
        const repositories = await this._getRepositories();
        // const filteredRepositories = this.permittedAccounts ? repositories.filter(repo => this.permittedAccounts.includes(`${repo.owner}/${repo.name}`)) : repositories;

        if (repositories.length === 0) return { totalCount: 0, data: [] };
        return { totalCount: 1, data: [{ orgName: repositories[0].owner, installationId: null, repositories }] };
    }

    async _handleInitError({ customerName, err }) {
        console.info('[BitbucketServiceMgr][_handleInitError] init error handling', err);
        const error = JSON.parse(err.message);
        if (error.status >= 400 && error.data.error_description === 'Invalid refresh_token') {
            await handleRevokedVcs({
                customerName,
                vcsType: SOURCE_TYPES.BITBUCKET,
                integrationId: this.integrationId,
                repositories: this.selectedRepositories,
                integrationLambdaName: process.env.INTEGRATION_API_LAMBDA,
                emailApiLambdaName: process.env.EMAIL_SERVICE_LAMBDA
            });
        }
    }

    async _fetchRepositories({ customerName }) {
        return await this._getRepositories(true);
    }

    async generateToken({ code, module, customerName }) {
        if (!code) throw new Error('bad params - no code exist');

        if (await this.isValidateTokenBasicPermissionsFeatureFlagEnabled({ customerName })) {
            return await this.validateTokenBasicPermissions({ code, module });
        }

        const tokenManager = new TokenManager({ code, module });
        await tokenManager.init();
        const tokenData = await tokenManager.getTokenData();
        const apiManager = new ApiManager({ accessToken: tokenData.access_token });
        const userData = await apiManager.getUser();
        return Object.assign(tokenData, userData);
    }

    async makePullRequest({
        customerName, owner, repoName, sourceBranchName, newFiles, // required
        commitMessage, commitAuthor, prTitle, prBody, closeSourceBranch, newBranchName
    }) { // optional
        this._createCustomLabels({ customerName });
        if (!customerName || !owner || !repoName || !sourceBranchName) {
            throw new Error('Bad params, missing some required params');
        }
        if (!newFiles || !Array.isArray(newFiles)) {
            throw new Error('Bad params, missing files [array] param');
        }
        if (!this.customerName) {
            await this.init({ customerName });
        }
        const pullRequestObjResponse = await this.apiManager.createPullRequest({
            workspace: owner,
            repositoryName: repoName,
            sourceBranchName,
            files: newFiles,
            commitMessage,
            commitAuthor,
            title: prTitle,
            description: prBody,
            closeSourceBranch,
            newBranchName
        });

        return new PullRequest({
            id: pullRequestObjResponse.id,
            webUrl: pullRequestObjResponse.links.html.href
        }).toJSON();
    }

    async commitAndPush({ customerName, owner, repoName, sourceBranchName, newFiles }) {
        this._createCustomLabels({ customerName });
        if (!customerName || !owner || !repoName || !sourceBranchName) {
            throw new Error('Bad params, missing some required params');
        }
        if (!newFiles || !Array.isArray(newFiles)) {
            throw new Error('Bad params, missing files [array] param');
        }
        if (!this.customerName) {
            await this.init({ customerName });
        }
        return this.apiManager.commitAndPush({
            workspace: owner,
            repositoryName: repoName,
            branchName: sourceBranchName,
            files: newFiles
        });
    }

    async _generateBCFullWebhookPath() {
        return `${this.apiGatewayUrl}${config.webHookRelativePath}`;
    }

    async _getHooksFromVCS(entity) {
        return await this.apiManager.getHooks({ workspace: entity.owner, repositoryName: `${entity.name}` });
    }

    _filterHooks({ hooks, BC_FULL_WEBHOOK_PATH }) {
        return hooks.filter(repoHook => repoHook.url && repoHook.url === BC_FULL_WEBHOOK_PATH);
    }

    async _deleteHooks({ bcHooks, entity }) {
        await Promise.all(bcHooks.map(hook => this.apiManager.deleteHook({ workspace: entity.owner, repositoryName: entity.name, id: hook.uuid })));
    }

    async _createHook({ entity, BC_FULL_WEBHOOK_PATH }) {
        await this.apiManager.setHook({
            workspace: entity.owner,
            repositoryName: entity.name,
            description: config.webhookDescription,
            url: BC_FULL_WEBHOOK_PATH,
            active: true,
            events: config.webhookEvents
        });
    }

    /**
     * Update repositories webhook events according to the repositories and delete old ones that saved on the integration table (the repositories that the user choose)
     * @param customerName - String
     * @param repositories - Array of Strings e.g: ['livnoni/test_repo1', 'livnoni/test_repo2' ...]
     * @returns {Promise<void>} Object that describe if the webhook DELETED/CREATED/DO_NOTHING for each repository, e.g:
     *  {
     *      'brdgecrew/test_repo2': 'DELETED',
     *      'brdgecrew/test_repo3': 'CREATED',
     *      'livnoni/test_repo4': 'DO_NOTHING',
     *  }
     */
    async updateRepositoriesWebhooksEvents({ customerName, repositories }) {
        this._createCustomLabels({ customerName });
        console.info(`updating webhooks for for customer: ${customerName} chosen repositories: ${repositories}`);
        if (!this.customerName) {
            await this.init({ customerName });
        }

        // eslint-disable-next-line no-param-reassign
        repositories = repositories || this.selectedRepositories;

        if (!customerName || !repositories) {
            throw new Error('Bad params, missing some required params');
        }
        if (!Array.isArray(repositories)) {
            throw new Error('Bad params, repositories not array!');
        }
        const totalRepositories = await this._getRepositories();
        const notFoundErrors = [];
        const stats = {};
        const BC_FULL_WEBHOOK_PATH = `${this.apiGatewayUrl}${config.webHookRelativePath}`;
        // const OLD_WEBHOOKS = [`${PROD_INVOKE_URL}/${config.webHookRelativePath}`];

        const updateHook = async ({ repository, bcHooks, fullRepoName }) => {
            const isRepoChosen = repositories.includes(fullRepoName);
            const hasBcHooks = bcHooks.length > 0;

            if (hasBcHooks && isRepoChosen) {
                await Promise.all(bcHooks.map(hook => this.apiManager.deleteHook({
                    workspace: repository.owner,
                    repositoryName: repository.name,
                    id: hook.uuid
                })));
                // the repo already has bc hooks and user want's to subscribe
                await this.apiManager.setHook({
                    workspace: repository.owner,
                    repositoryName: repository.name,
                    description: config.webhookDescription,
                    url: BC_FULL_WEBHOOK_PATH,
                    active: true,
                    events: config.webhookEvents
                });
                stats[fullRepoName] = 'CREATED';
            }
        };

        await promiseAllWithRateLimit({
            arr: totalRepositories,
            maxConcurrent: 50,
            callback: async (repository) => {
                let repositoryHooks;
                try {
                    repositoryHooks = await this.apiManager.getHooks({ workspace: repository.owner, repositoryName: `${repository.name}` });
                } catch (e) {
                    const errorStatus = e.response && e.response.status;
                    if (errorStatus !== 404 && errorStatus !== 403) throw e;
                    switch (errorStatus) {
                        case 404:
                            console.error(`got ${e.response.status} while getting hooks for full repo path: ${repository.owner}/${repository.name} - it means repo does't exist, probably deleted`);
                            break;
                        case 403:
                            console.error(`got ${e.response.status} while getting hooks for full repo path: ${repository.owner}/${repository.name} - it means the authenticated user does not have permission to install webhooks on the specified repository`);
                            break;
                        default:
                            console.error(`got ${e.response.status} while getting hooks for full repo path: ${repository.owner}/${repository.name}`);
                    }
                    notFoundErrors.push(e);
                    if (notFoundErrors.length >= totalRepositories.length) {
                        throw new Error(`got 'Not Found' errors for all the repositories! errors: ${notFoundErrors}`);
                    }
                    return; // try to fetch the next repository hooks
                }
                const bcHooks = repositoryHooks.filter(repoHook => repoHook.url && repoHook.url === BC_FULL_WEBHOOK_PATH);
                const fullRepoName = `${repository.owner}/${repository.name}`;

                await updateHook({ repository, bcHooks, fullRepoName });
            }
        });
        console.log(`finish update subscribe / unsubscribe webhook for customer: ${customerName} stats=`, stats);
        return stats;
    }

    async updateRepositoriesWebhooksEventsForCustomers({ customersNamesArr }) {
        const resultObj = {};
        await Promise.all(customersNamesArr.map(async customerName => {
            resultObj[customerName] = await this.updateRepositoriesWebhooksEvents({ customerName });
        }));

        return resultObj;
    }

    async _getPulRequestFiles({ workspace, repositoryName, pullRequestId }) {
        const pullRequestDiffStatResponse = await this.apiManager.getPullRequestDiffStat({ workspace, repositoryName, pullRequestId });
        const filesThatHaveChanged = pullRequestDiffStatResponse.reduce((paths, prDiffObj) => {
            if (prDiffObj.new && prDiffObj.new.path) {
                paths.push(prDiffObj.new.path);
            }
            return paths;
        }, []);
        console.log(`files that have changed at the PR: ${pullRequestId} :`, filesThatHaveChanged);
        return filesThatHaveChanged;
    }

    async _getFilesAndUploadToS3({ filePaths, workspace, repositoryName, nodeHash, prefix, fromBranch, customerName }) {
        // TODO: remove _getFilesAndUploadToS3 from all VCS - BCE-7326
        if (filePaths.length > config.maxFilesForAPIDownload) {
            return this._getFilesByCloneAndUploadToS3({ filePaths, workspace, repositoryName, nodeHash, prefix, fromBranch, customerName });
        }
        console.info(`getting and uploading ${filePaths.length} files...`);
        const files = await promiseAllWithRateLimit({
            arr: filePaths,
            maxConcurrent: 50,
            callback: (async path => {
                const file = new File({ path, encoding: config.encoding });
                file.content = await this.apiManager.getFileContent({
                    workspace,
                    repositoryName,
                    nodeHash,
                    filePath: path
                });
                await file.save({ prefix, bucket: SCAN_RESULTS_BUCKET });
                return file;
            })
        });
        console.info(`successfully got and uploaded ${files.length} files`);
        return files;
    }

    async _getFilesByCloneAndUploadToS3({ filePaths, workspace, repositoryName, nodeHash, prefix, fromBranch, customerName }) {
        console.info(`cloning and uploading ${filePaths.length} files...`);
        if (config.isLocal && !fs.existsSync('clones')) {
            fs.mkdirSync('clones');
        }

        const reposFolderPath = config.isLocal ? 'clones' : '/tmp';
        const fullRepoName = `${workspace}/${repositoryName}`;
        const clonePath = `${reposFolderPath}/${customerName}/${fullRepoName}/${fromBranch}/${nodeHash}`;
        const files = [];
        try {
            this.apiManager.cloneBranch({ fullRepoPath: fullRepoName, clonePath, branchName: fromBranch });
            for (const filePath of filePaths) {
                const file = new File({ path: filePath, encoding: config.encoding });
                const localPath = `${clonePath}/${filePath}`;
                try {
                    file.content = fs.readFileSync(localPath, { encoding: 'utf8' });
                    await file.save({ prefix, bucket: SCAN_RESULTS_BUCKET });
                    files.push(file);
                } catch (e) {
                    console.error(`Failed to read file ${localPath}. Skipping.`);
                }
            }
        } catch (e) {
            throw new Error(e);
        } finally {
            execSync(`rm -rf ${clonePath}`, { encoding: 'utf8', stdio: 'inherit' });
        }
        console.info(`successfully got and uploaded ${files.length} files`);
        return files;
    }

    // todo: move to interface
    static async _runCheckovScan({ uniqueID, workspace, repositoryName, scanPath, customerName }) {
        try {
            const checkovSetupResult = await new AWS.Lambda().invoke({
                FunctionName: CHECKOV_SETUP_LAMBDA_NAME,
                Payload: JSON.stringify({ customerName, owner: workspace, name: repositoryName, scanPath: { path: scanPath }, customerRepositories: { runId: uniqueID, triggerType: 'CICD' } }),
                Qualifier: qualifier
            }).promise();

            console.info('checkovSetupResult response: ', checkovSetupResult);

            if (!checkovSetupResult || !checkovSetupResult.Payload) {
                throw new Error('Bad response from checkov scanner graph create, payload:', checkovSetupResult);
            }
            const { scansByFramework } = JSON.parse(checkovSetupResult.Payload);

            console.info('scansByFramework: ', scansByFramework);

            const checkovGraphResult = await new AWS.Lambda().invoke({
                FunctionName: SCANNER_CHECKOV_LAMBDA_NAME,
                Payload: JSON.stringify(scansByFramework),
                Qualifier: qualifier
            }).promise();

            console.info('checkovGraphResult response: ', checkovGraphResult);

            if (!checkovGraphResult || !checkovGraphResult.Payload) {
                throw new Error('Bad response from checkov scanner graph create, payload:', checkovGraphResult);
            }

            const checkovScanResultObj = await new AWS.Lambda().invoke({
                FunctionName: SCANNER_CHECKOV_LAMBDA_NAME,
                Payload: checkovGraphResult.Payload,
                Qualifier: qualifier
            }).promise();
            const checkovScanResult = JSON.parse(checkovScanResultObj.Payload);
            const checkovScanResultPaths = checkovScanResult.checksResultsPaths;

            console.info('checkovScanResult response: ', checkovScanResultPaths);

            const payload = checkovScanResultPaths;
            if (!payload.terraform || !payload.cloudformation) {
                throw new Error('Bad response from checkov scanner, payload:', payload);
            }
            console.info(`checkov scan results: workspace: ${workspace} repositoryName: ${repositoryName} checkovResult=\n${JSON.stringify(checkovScanResult)}`);
            return payload;
        } catch (e) {
            console.error('got error while running checkov scan, error:', e);
            throw e;
        }
    }

    static async _readFromS3(key) {
        try {
            const s3Object = await s3.getObject({ Bucket: SCAN_RESULTS_BUCKET, Key: key }).promise();
            return JSON.parse(s3Object.Body.toString());
        } catch (e) {
            console.error(`got error while reading result from s3, key: ${key}, error:`, e);
            throw e;
        }
    }

    static async createAnnotations({ checksResultObj, scannerType, violationConfigurationsMap, customerName, sourceId, repoConf, isPrisma, repositoryRule }) {
        const annotations = [];

        /**
         * @param checks - array of cehcks objects (passed_checks/failed_checks/skipped_checks)
         * @param checkType - String e.g: terraform/cloudformation/kubernetes
         */
        const addBulkAnnotations = async ({ checks, checkType }) => {
            for (const check of checks) {
                const checkId = check.check_id; // e.g: CKV_AWS_62
                const checkName = check.check_name || checkId; // e.g: Ensure IAM role allows only specific services or principals to assume it
                const checkResultStatus = check.check_result.result; // eg: PASSED / FAILED / SKIPPED
                // eslint-disable-next-line camelcase
                const { resource, file_path } = check; // e.g: aws_iam_user_policy.userpolicy
                const resourceNameArr = resource.split('.');
                const path = check.file_path.startsWith('/') ? check.file_path.substr(1) : check.file_path; // e.g: terraform/iam.tf
                const lines = check.file_line_range; // e.g: [7,10]
                const violationConfiguration = violationConfigurationsMap[checkId]; // row of conf_violations table
                if (!violationConfiguration?.incidentId) {
                    // temporary - for monitoring failures due to lack of violationConfiguration
                    if (!violationConfiguration) {
                        console.warn(`[BitbucketServiceMgr][createAnnotations][addBulkAnnotations] Check ${checkId} not found in violationConfigurationsMap`, { check, checkId, violationConfigurationsMap });
                    } else {
                        console.warn(`[BitbucketServiceMgr][createAnnotations][addBulkAnnotations] Check ${checkId} found in violationConfigurationsMap but has no incidentId`, { violationConfiguration, check, checkId, violationConfigurationsMap });
                    }
                }

                let isSuppressed = false;
                if (violationConfiguration && violationConfiguration.incidentId) {
                    // eslint-disable-next-line camelcase
                    isSuppressed = await checkIsSuppressed({ violationId: violationConfiguration.incidentId, resourceId: `${file_path}:${resource}`, customerName, sourceId });
                }
                // Bitbucket does not support INFO, so it must be LOW
                let severity;
                if (violationConfiguration) {
                    if (violationConfiguration.severity === 'INFO') {
                        severity = 'LOW';
                    } else {
                        severity = violationConfiguration.severity;
                    }
                } else {
                    severity = 'MEDIUM';
                }

                const commentTitleObjKey = isPrisma ? 'descriptiveTitle' : 'constructiveTitle'; // TODO - check why not just 'title' like in github
                if (!isSuppressed && violationConfiguration?.incidentId && violationConfiguration.incidentId !== 'BC_VUL_1' && violationConfiguration.incidentId !== 'BC_VUL_2'
                    && (
                        (!repositoryRule && isViolationRelevant({ violationConfiguration, repoConf }))
                        || (repositoryRule
                            && isViolationRelevantByEnforcementRules({
                                repositoryRule,
                                violationId: violationConfiguration.incidentId,
                                severity,
                                customViolation: violationConfiguration.isCustom,
                                thresholdName: THRESHOLD_SEVERITY_NAMES.COMMENTS_BOT_THRESHOLD
                            }))
                    )) {
                    annotations.push({
                        external_id: `BC-ANNOTATION-${scannerType}-${checkType}-${checkId}-${path}-${resource}-${lines}-${checkResultStatus}`,
                        title: violationConfiguration ? violationConfiguration.incidentId : checkName,
                        annotation_type: 'VULNERABILITY',
                        summary: `(${checkResultStatus}) ${violationConfiguration ? `${violationConfiguration[commentTitleObjKey]} (${violationConfiguration.incidentId})` : checkName}`,
                        details: `${violationConfiguration
                            ? `Category: ${violationConfiguration.category} | `
                            : ''}Resource: ${resourceNameArr[0]} ${resourceNameArr[1] ? `[${resourceNameArr[1]}]` : ''}, ${(lines && Array.isArray(lines)) ? `${lines[0]} - ${lines[1]}` : ''}`,
                        severity,
                        path,
                        line: lines && Array.isArray(lines) ? lines[0] : '',
                        result: checkResultStatus,
                        link: (violationConfiguration && !violationConfiguration.isCustom) ? violationConfiguration.guideline : undefined
                    });
                }
            }
        };

        const checkTypes = Object.keys(checksResultObj); // [terraform, cloudformation, kubernetes]
        for (const checkType of checkTypes) {
            const checkResults = checksResultObj[checkType];
            await addBulkAnnotations({ checks: [].concat(...Object.values(checkResults)), checkType, scannerType });
        }

        return annotations;
    }

    static getReportMetaData(annotations) {
        const stats = annotations.reduce((acc, annotation) => {
            acc[annotation.result]++;
            return acc;
        }, { PASSED: 0, FAILED: 0, SKIPPED: 0 });

        return Object.keys(stats).map(status => ({ type: 'NUMBER', title: status, value: stats[status] }));
    }

    static async _convertChekovResultToBitbucketAnnotaions({ checkovResult, scannerType, violationConfigurationsMap, customerName, sourceId, repoConf, isPrisma, repositoryRule }) {
        const { terraform, cloudformation, kubernetes } = checkovResult;

        const [terraformResults, cloudformationResults, kubernetesResults] = await Promise.all([BitbucketServiceMgr._readFromS3(terraform), BitbucketServiceMgr._readFromS3(cloudformation), BitbucketServiceMgr._readFromS3(kubernetes)]);

        const checksResultObj = {
            terraform: terraformResults.checks,
            cloudformation: cloudformationResults.checks,
            kubernetes: kubernetesResults.checks
        };

        console.info(`checksResultObj=\n${JSON.stringify(checksResultObj)}`);

        const annotations = await BitbucketServiceMgr.createAnnotations({ checksResultObj, scannerType, violationConfigurationsMap, customerName, sourceId, repoConf, isPrisma, repositoryRule });

        console.info(`annotations=\n${JSON.stringify(annotations)}`);

        return annotations;
    }

    // todo: move to interface
    async handlePullRequest({ eventType, customerName, repoSettingSchema, workspace, repositoryName, pullRequestId, prTitle, nodeHash, violationConfigurationsMap, scannerType, fromBranch, intoBranch, author, domain, isPrisma, enforcementRulesEnabled }) {
        this._createCustomLabels({ customerName });
        console.info(`handle pull request for customer: ${customerName} full repo path: ${workspace}/${repositoryName} for pull request id: ${pullRequestId}
         pr title: ${prTitle} nodeHash: ${nodeHash} repoSettingSchema: ${JSON.stringify(repoSettingSchema)}`);
        let repositoryRule = null;
        if (!customerName || !workspace || !repositoryName || !pullRequestId) {
            throw new Error('Bad params, missing some required params');
        }
        if (!this.customerName) {
            await this.init({ customerName });
        }
        if (this.module === MODULE_TYPE.PC) {
            convertSeverityForPrisma({ violationConfigurationsMap });
        }
        if (!domain) {
            console.error('[BitbucketServiceMgr][handlePullRequest] Failed to get application domain(PC or BC app url).', { customerName, domain });
            throw new Error(`[BitbucketServiceMgr][handlePullRequest] Failed to get application domain for customer: ${customerName}`);
        }
        const module = isPrisma ? MODULE_TYPE.PC : MODULE_TYPE.BC;
        const reportConf = TEXT_CONFIG[module].codeReviews[SOURCE_TYPES.BITBUCKET].REPORT;
        const reportParams = {
            details: reportConf.details,
            title: reportConf.title,
            type: reportConf.type,
            reporter: reportConf.reporter,
            link: domain,
            logo_url: reportConf.getLogoURL(process.env.AWS_ACCOUNT_ID, process.env.TAG, process.env.AWS_REGION)
        };
        console.log('enforcement rules feature-flag value', enforcementRulesEnabled);
        if (eventType === config.eventTypes.PR_CREATED || eventType === config.eventTypes.PR_UPDATED) {
            if (fromBranch.startsWith(BRANCH_PREFIXES.PLATFORM_PR_BRANCH_PREFIX)) {
                await this.createPlatformPREntity(({ fromBranch, intoBranch, customerName, owner: workspace, source: this.sourceType, repositoryName, number: pullRequestId, title: prTitle, author }));
                return;
            }
            if (fromBranch.startsWith(BRANCH_PREFIXES.YOR_PR_BRANCH_PREFIX)) {
                console.info(`Skip on PR flow since this branch name: ${fromBranch} starts with: ${BRANCH_PREFIXES.YOR_PR_BRANCH_PREFIX}`);
                return;
            }
            // Check if the commit already exists
            const existingRun = await cicdRemoteLambda.invoke('CICD/getRun', {
                repositoryName,
                repositoryOwner: workspace,
                source: SOURCE_TYPES.BITBUCKET,
                customerName,
                fromBranch,
                intoBranch,
                pr: pullRequestId,
                commit: nodeHash
            });
            console.log('Existing run: ', existingRun);

            if (!existingRun) {
                const bitbucketCodeReviewIntegration = new BitbucketCodeReviewIntegration({
                    serviceMgr: this,
                    sourceType: SOURCE_TYPES.BITBUCKET,
                    customerName,
                    repository: repositoryName,
                    owner: workspace,
                    pr: pullRequestId,
                    prTitle,
                    commit: nodeHash,
                    fromBranch,
                    intoBranch,
                    author,
                    repoSettingSchema,
                    domain,
                    isPrisma,
                    enforcementRulesEnabled
                });

                await bitbucketCodeReviewIntegration.start();
            }
        }

        if (eventType === config.eventTypes.PR_MERGED || eventType === config.eventTypes.PR_CLOSED) {
            await handleYorClosedMergedPR({
                owner: workspace,
                name: repositoryName,
                prNumber: pullRequestId,
                repositoriesApiLambda: process.env.REPOSITORIES_API_LAMBDA,
                yorPRLambdaName: process.env.YOR_PR_LAMBDA,
                isMerged: eventType === config.eventTypes.PR_MERGED
            });
        }

        if (eventType === config.eventTypes.PR_MERGED) {
            await this.handleMergedPR({ customerName, workspace, repo: repositoryName, pullNumber: pullRequestId, intoBranchName: intoBranch, defaultBranchName: fromBranch, eventType });
        }

        if (eventType === config.eventTypes.PR_MERGED || eventType === config.eventTypes.PR_CLOSED) {
            const status = eventType === config.eventTypes.PR_MERGED ? PR_STATUS.MERGED : PR_STATUS.CLOSED;
            await this.updatePREntityStatus({ fromBranch, number: pullRequestId, owner: workspace, repositoryName, customerName, status, source: this.sourceType });
            console.log('pr is merged/closed. returned without pr comments');
        }

        if (enforcementRulesEnabled === true) {
            repositoryRule = await enforcementRulesApiLambda.invoke('enforcementRulesService/getSchemeForAccountByFullNameAndSource', {
                customerName,
                owner: workspace,
                name: repositoryName,
                source: SOURCE_TYPE
            });
            console.log('repository rule', repositoryRule);
        }
        const repoConf = await getVCSRepoConfIfFeatureEnabled({ repoSettingSchema, customerName, featureName: 'prComments', fullRepoName: `${workspace}/${repositoryName}` });
        if (!enforcementRulesEnabled && !repoConf) {
            console.info(`pullRequestId: ${pullRequestId} of repo: ${workspace}/${repositoryName} for customer: ${customerName} will not get comments since it is disabled`);
            return true;
        }

        const reportId = `BC-REPORT-${customerName}-${pullRequestId}-${nodeHash}`;

        await this.apiManager.createReport({ workspace, repositoryName, commitHash: nodeHash, reportId, status: config.reportStatus.pending, reportParams });

        const pullRequestFiles = await this._getPulRequestFiles({ workspace, repositoryName, pullRequestId });

        if (pullRequestFiles.length === 0) {
            console.info('pull request does\'t have relevant files');
            return this.apiManager.createReport({ workspace, repositoryName, commitHash: nodeHash, reportId, status: config.reportStatus.passed, reportParams });
        }

        const filesWithPath = pullRequestFiles.map(filePath => ({ path: filePath }));
        const filteredFromSchemaFiles = removeExcludedFiles({ repoSettingSchema, files: filesWithPath, pathInFile: 'path', fullRepoName: `${workspace}/${repositoryName}` });
        if (!filteredFromSchemaFiles || !filteredFromSchemaFiles.length) {
            console.info('all the changed files where excluded');
            return this.apiManager.createReport({ workspace, repositoryName, commitHash: nodeHash, reportId, status: config.reportStatus.passed, reportParams });
        }
        const filteredPaths = filteredFromSchemaFiles.map(fileWithPath => fileWithPath.path);
        const prefix = `${scannerType}/${customerName}/${workspace}/${repositoryName}/COMMENTS/${pullRequestId}/${nodeHash}/${SRC}`;
        await this._getFilesAndUploadToS3({ filePaths: filteredPaths, workspace, repositoryName, nodeHash, scannerType, prefix, fromBranch, customerName });

        const checkovResult = await BitbucketServiceMgr._runCheckovScan({ uniqueID: `PR-COMMENT-${pullRequestId}-${nodeHash}`, workspace, repositoryName, scanPath: prefix, customerName });

        const annotations = await BitbucketServiceMgr._convertChekovResultToBitbucketAnnotaions({ checkovResult, scannerType, violationConfigurationsMap, isPrisma, customerName, sourceId: `${workspace}/${repositoryName}`, repoConf, repositoryRule });

        if (annotations.length > 0) {
            const chunkSize = config.annotationsMaxChunkSize;
            if (annotations.length > chunkSize) {
                console.info(`annotation length is: ${annotations.length} - separate to chunks of ${chunkSize} annotations`);
                const chunks = [];
                for (let i = 0; i < annotations.length; i += chunkSize) {
                    const chunk = annotations.slice(i, i + chunkSize);
                    chunks.push(chunk);
                }
                for (const annotationChunk of chunks) {
                    await this.apiManager.setReportAnnotations({ workspace, repositoryName, commitHash: nodeHash, reportId, annotations: annotationChunk });
                }
            } else {
                await this.apiManager.setReportAnnotations({ workspace, repositoryName, commitHash: nodeHash, reportId, annotations });
            }
        }

        const reportResponse = await this.apiManager.createReport({
            workspace,
            repositoryName,
            commitHash: nodeHash,
            reportId,
            status: annotations.some(annotation => annotation.result === config.reportStatus.failed) ? config.reportStatus.failed : config.reportStatus.passed,
            data: BitbucketServiceMgr.getReportMetaData(annotations),
            reportParams
        });

        const tenant = await customersRemoteLambda.invoke('getCustomerByName', { name: customerName });
        if (!tenant || !tenant.owner_email) {
            console.warn(`couldn't find owner email for customer: ${customerName}, tracking event won't be sent`);
            return reportResponse;
        }
        await trackingRemoteLambda.invoke('service/sendTracking', { event: 'BitbucketAutomatedPullRequest', org: customerName, email: tenant.owner_email, type: null, pullRequestScanCommentNumber: annotations.length }, undefined, { Async: true });

        return reportResponse;
    }

    async getChangedPRFiles({ workspace, customerName, repositoryName, pullRequestId, nodeHash, fromBranch }) {
        this._createCustomLabels({ customerName });
        if (!this.apiManager) {
            await this.init({ customerName });
        }
        const pullRequestFiles = await this._getPulRequestFiles({ workspace, repositoryName, pullRequestId });

        const repoSettingSchema = await settingsMgrApiLambda.invoke('vcsSettings/getScheme', { customerName, fullRepoName: `${workspace}/${repositoryName}` });

        const filesWithPath = pullRequestFiles.map(filePath => ({ path: filePath }));
        const filteredFromSchemaFiles = removeExcludedFiles({ repoSettingSchema, files: filesWithPath, pathInFile: 'path', fullRepoName: `${workspace}/${repositoryName}` });
        if (!filteredFromSchemaFiles || !filteredFromSchemaFiles.length) {
            console.info('all the changed files where excluded');
            return { scanPaths: [] };
        }
        const filteredPaths = filteredFromSchemaFiles.map(fileWithPath => fileWithPath.path);

        const prefix = `checkov/${customerName}/${workspace}/${repositoryName}/PRs/${pullRequestId}/${nodeHash}/${SRC}`;
        await this._getFilesAndUploadToS3({ filePaths: filteredPaths, workspace, repositoryName, nodeHash, scannerType: 'checkov', prefix, fromBranch, customerName });

        return { scanPaths: [{ owner: workspace, name: repositoryName, path: prefix, public: true }] };
    }

    async setPRCheck({ runId, commitHash, workspace, state = BITBUCKET_CHECK_STATUSES.INPROGRESS, repositoryName, detailsURL, prCheckTitle }) {
        const data = {
            key: runId,
            state,
            name: prCheckTitle,
            url: detailsURL,
            description: BITBUCKET_CHECK_MESSAGES[state]
        };

        return await this.apiManager.updateBuild({
            workspace,
            repositoryName,
            commitHash,
            data
        });
    }

    async _updatePrCheckStatus({ customerName, owner, repo, sha, state, runNumber, detailsURL, prCheckTitle, description, manuallyPassed = false }) {
        console.log('[bitbucketServiceMgr][updatePrCheckStatus]', { customerName, owner, repo, detailsURL, prCheckTitle, state });
        try {
            const data = {
                key: runNumber,
                state,
                name: prCheckTitle,
                url: detailsURL,
                description
            };

            await this.apiManager.updateBuild({
                workspace: owner,
                repositoryName: repo,
                commitHash: sha,
                data
            });

            return { result: 'success' };
        } catch (e) {
            console.error('[bitbucketServiceMgr][updatePrCheckStatus] failed to update pr check status', e);
            throw new Error('[bitbucketServiceMgr][updatePrCheckStatus] failed to update pr check status');
        }
    }

    async handleMergedPR({ customerName, workspace, repo, pullNumber, intoBranchName }) {
        this._createCustomLabels({ customerName });
        const repository = await this.apiManager.getRepository({ workspace, repositoryName: repo });
        const defaultBranch = repository.mainbranch ? repository.mainbranch.name : config.defaultBranch;
        const isMergedToDefaultBranch = intoBranchName === defaultBranch;
        let suppressedResources;
        try {
            suppressedResources = await cicdRemoteLambda.invoke('CICD/handleMergedCICDRun', {
                customerName,
                owner: workspace,
                repository: repo,
                pullNumber,
                shouldGetSuppressedResources: isMergedToDefaultBranch
            });
        } catch (e) {
            throw new Error(`Failed to handle merged cicd run for ${customerName}, resources: ${suppressedResources}`);
        }

        if (isMergedToDefaultBranch && suppressedResources && (suppressedResources.cves.length || suppressedResources.violationResources.length)) {
            await suppressViolationsUponMergeToDefaultBranch({
                accountId: `${workspace}/${repo}`,
                violationResources: suppressedResources.violationResources,
                cves: suppressedResources.cves,
                customerName
            });
            return true;
        }
        return false;
    }

    async generateReposTokens({ customerName }) {
        await this.init({ customerName });
        const repositories = await this._getRepositories();
        const repoTokens = [];
        this.selectedRepositories.forEach(selectedRepository => { // validate repos are equal for current repos from bitbucket cloud
            const repository = repositories.find(repo => `${repo.owner}/${repo.name}` === selectedRepository);
            if (repository) {
                repoTokens.push({ repository, userName: this.userName, token: this.apiManager.accessToken });
            }
        });
        return repoTokens;
    }

    async validateTokenBasicPermissions({ code, module }) {
        console.log('[bitbucketServiceMgr] - validateTokenBasicPermissions', { code, module });
        const oathValidator = new BitbucketValidator(code, module, ApiManager, TokenManager);
        return await oathValidator.validateTokenBasicPermissions();
    }
}

module.exports = { BitbucketServiceMgr };
