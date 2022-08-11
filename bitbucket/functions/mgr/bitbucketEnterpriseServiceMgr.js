const RemoteLambda = require('@bridgecrew/nodeUtils/remoteLambda/invoke');
const Repository = require('@bridgecrew/nodeUtils/models/VersionControl/repository');
const File = require('@bridgecrew/nodeUtils/models/VersionControl/file');
const PullRequest = require('@bridgecrew/nodeUtils/models/VersionControl/pullRequest');
const vcsSSmMgr = require('@bridgecrew/vcs-ssm-mgr');
const { THRESHOLD_SEVERITY_NAMES, PR_STATUS } = require('@bridgecrew/dal-layer');
const { promiseAllWithRateLimit } = require('@bridgecrew/nodeUtils/common/promiseAllWithRateLimit');
const { suppressViolationsUponMergeToDefaultBranch, handleYorClosedMergedPR, checkIsSuppressed } = require('@bridgecrew/nodeUtils/vcs/utils');
const { removeExcludedFiles, isViolationRelevant } = require('@bridgecrew/nodeUtils/vcs/repoSettingSchema');
const { TEXT_CONFIG } = require('@bridgecrew/nodeUtils/vcs/uiTextConfig');
const { isViolationRelevantByEnforcementRules } = require('@bridgecrew/vcs-utils');
const { SOURCE_TYPES, BITBUCKET_CHECK_STATUSES, BITBUCKET_CHECK_MESSAGES, VIOLATION_STATUSES, REPOS_SELECTION_TYPES } = require('@bridgecrew/nodeUtils/models/Enums');
const { BRANCH_PREFIXES } = require('../../../utils/index');

const CHUNK_SIZE = 10000;
const SOURCE_TYPE = SOURCE_TYPES.BITBUCKET_ENTERPRISE;
const SCANNER_TYPE = 'checkov';
const settingsMgrApiLambda = new RemoteLambda(process.env.SETTINGS_MGR_API_LAMBDA);
const cicdRemoteLambda = new RemoteLambda(process.env.CICD_API_LAMBDA_NAME);

const { SCAN_RESULTS_BUCKET } = process.env;

const BitbucketCodeReviewIntegration = require('./CodeReview/index');

const ApiManager = require('./apis/bitbucketEnterpriseApiManager');
const BaseVCSClass = require('../../../models/baseClass');
const config = require('./conf/config').bitbucketEnterpriseserviceManager;

const SRC = 'src';
/**
 * Class for Bitbucket server - https://www.atlassian.com/software/bitbucket/download
 */
class BitbucketEnterpriseServiceMgr extends BaseVCSClass {
    /**
     * this.apiManager: instance of ApiManager
     * this.customerName: String
     * this.selectedRepositories: Array of String
     */
    constructor() {
        super(SOURCE_TYPES.BITBUCKET_ENTERPRISE);
        this.apiManager = null;
        this.customerName = null;
        this.integrationName = 'Bitbucket Enterprise';
        this.selectedRepositories = []; // the repositories that stored on the integration table
        this.module = null;
        console.info(`created service Mgr ${this.integrationName} instance`);
    }

    async init({ customerName }) {
        this.customerName = customerName;
        const integrationData = await this._getIntegrationData({ customerName });
        if (integrationData && integrationData.length > 0) {
            const { id, params, integration_details: integrationDetails } = integrationData[0];
            this.selectedRepositories = params.repositories;
            this.apiManager = new ApiManager({ accessToken: params.accessToken, baseURL: params.baseURL, customerName });
            this.accessToken = params.accessToken;
            this.baseURL = params.baseURL;
            this.module = params.module;
            const vcsSSmMgrInstance = vcsSSmMgr.getInstance();
            this.apiGatewayUrl = await vcsSSmMgrInstance.getGlobalRedirectUrl(params.module);
            this.integrationId = id;
            this.reposSelectionType = params.reposSelectionType;
            this.updatedByPcUser = integrationDetails.updatedByPcUser;

            return true;
        }
        return false;
    }

    async _getRepositories() {
        const repositories = await this.apiManager.getRepositories();
        return repositories.map((repo) => new Repository(
            // no fork or default branch returns for the get repository request. we can get it with another API's
            {
                id: repo.id,
                owner: repo.project.key,
                name: repo.slug,
                isPublic: repo.public || false,
                url: repo.links.self && repo.links.self.length > 0 ? repo.links.self[0].href : null,
                description: repo.description
            }
        ));
    }

    _isRateLimitError(err) {
        const { message, statusCode } = this._extractDetailsFromError(err);
        return statusCode === 429 || (message && message.includes('Rate limit')); // Rate limit for this resource has been exceeded
    }

    async _getFilesStructureParameters({ customerName, repositories }) {
        const maxConcurrent = 1;
        return { maxConcurrent, chunkSize: CHUNK_SIZE, extraParameters: {} };
    }

    _getShouldCloneValue({ fileLength }) {
        return fileLength > config.downloadIndividualFilesThreshold;
    }

    _extractVCSParametersFromRepository({ repository }) {
        return { branchRef: repository.branchRef };
    }

    async _fetchRepositoryFilesStructure({ customerName, scannerType, repo, extraParameters }) {
        let files = [];
        const { branchRef } = repo;
        const defaultValue = { scanPath: null, repository: null };
        const fullRepoName = `${repo.owner}/${repo.name}`;
        const repoPath = `${scannerType}/${customerName}/${repo.owner}/${repo.name}/${repo.defaultBranch}/${SRC}`;
        try {
            console.log(`[BitbucketEnterpriseServiceMgr][_fetchRepositoryFilesStructure] - successfully got latest branch reference: ${branchRef} for branch: ${repo.defaultBranch}`);
            files = await this.apiManager.getFiles({ projectKey: repo.owner, repositorySlug: repo.name, ref: branchRef });
            files = files.map(file => new File({
                repoId: repo.id,
                path: file,
                repo,
                branchRef,
                encoding: config.encoding,
                prefix: repoPath
            }));
            files = await this._removeExcludedFilesByScheme({ customerName, fullRepoName, files });
        } catch (err) {
            if (this._isRateLimitError(err)) {
                console.error(`[BitbucketEnterpriseServiceMgr][_fetchRepositoryFilesStructure] - Rate limit error for customer ${customerName}`, err);
                throw this._createRateLimitError({ customerName });
            }
            this.errorHandler.wrapErrorWithVCSData(err, customerName, { owner: repo.owner, name: repo.name, customerName, repoId: repo.id, branchRef, branch: repo.defaultBranch }, this.errorHandler.GET_REPOSITORIES_FILES_STRUCTURE_PHASE_NAME);
            console.error(`[BitbucketEnterpriseServiceMgr][_fetchRepositoryFilesStructure] - failed to fetch repository '${repo.name}' structure, repository will ignored`, err);
            this.errorHandler.setErrorInMonitoringApp(err);
            return defaultValue;
        }
        if (!Array.isArray(files) || files.length === 0) {
            console.info('[BitbucketEnterpriseServiceMgr][_fetchRepositoryFilesStructure] - There are no valid files for scan in repository', { customerName, fullRepoName });
            return defaultValue;
        }
        console.log(`[BitbucketEnterpriseServiceMgr][_fetchRepositoryFilesStructure] - repository has ${repo.name} '${files.length}' files`);
        return {
            scanPath: { owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch, path: repoPath, public: repo.isPublic, url: repo.url, repoId: repo.id },
            repository: { name: repo.name, owner: repo.owner, public: repo.isPublic, url: repo.url, branch: repo.defaultBranch, repoPath, files }
        };
    }

    async getRepository({ customerName, repositoryOwner, repositoryName }) {
        if (!this.customerName) {
            await this.init({ customerName });
        }
        const repositoryResponse = await this.apiManager.getRepository({ projectKey: repositoryOwner, repositorySlug: repositoryName });
        const repo = await new Repository({
            // no fork or default branch returns for the get repository request. we can get it with another API's
            id: repositoryResponse.id,
            owner: repositoryResponse.project.key,
            name: repositoryResponse.slug,
            url: repositoryResponse.links.self && repositoryResponse.links.self.length > 0 ? repositoryResponse.links.self[0].href : null,
            defaultBranch: await this.apiManager.getDefaultBranch({ projectKey: repositoryOwner, repositorySlug: repositoryName }).then(r => r.branchName || null)
        });
        return repo;
    }

    async getRepositories({ customerName, permittedAccounts }) {
        if (!this.customerName) {
            await this.init({ customerName });
        }
        const repositories = await this._getRepositories();
        // const filteredRepositories = this.permittedAccounts ? repositories.filter(repo => permittedAccounts.includes(`${repo.owner}/${repo.name}`)) : repositories;

        if (repositories.length === 0) return { totalCount: 0, data: [] };
        return { totalCount: 1, data: [{ orgName: repositories[0].owner, installationId: null, repositories }] };
    }

    async _getDefaultBranch({ repository }) {
        console.info(`getting default branch to full repo: ${repository.owner}/${repository.name}`);
        let branchName, branchRef;
        try {
            const defaultBranchResponse = await this.apiManager.getDefaultBranch({ projectKey: repository.owner, repositorySlug: repository.name });
            branchName = defaultBranchResponse.branchName;
            branchRef = defaultBranchResponse.ref;
        } catch (e) {
            if (e && e.response && e.response.status === 404) {
                console.info(`got 404 for getting defaultBranch for repo: ${repository.name}`);
            } else {
                throw e;
            }
        }
        console.info(`the default branch is: ${branchName} and the last ref is: ${branchRef}`);

        return { branchName, branchRef };
    }

    async _fetchRepositories({ customerName }) {
        console.info('[BitbucketEnterpriseServiceMgr][_fetchRepositories] - fetch repositories', { customerName });
        let apiRepositories = await this._getRepositories();
        const repositories = [];
        console.log(`[BitbucketEnterpriseServiceMgr][_fetchRepositories] - number of api repositories for customer ${customerName}: ${apiRepositories.length}`);
        if (![REPOS_SELECTION_TYPES.CURRENT_REPOS_PENDING, REPOS_SELECTION_TYPES.CURRENT_REPOS_AND_FUTURE].includes(this.reposSelectionType)) {
            console.log(`[BitbucketEnterpriseServiceMgr][_fetchRepositories] - customer ${customerName} reposSelectionType is ${this.reposSelectionType} - going to filter api repositories`);
            apiRepositories = this._filterSelectedRepositories({ repositories: apiRepositories });
            console.log(`[BitbucketEnterpriseServiceMgr][_fetchRepositories] - number of api repositories after filter for customer ${customerName}: ${apiRepositories.length}`);
        }
        await promiseAllWithRateLimit({
            arr: apiRepositories,
            maxConcurrent: 2,
            callback: (async repository => {
                try {
                    const { branchName, branchRef } = await this._getDefaultBranch({ repository });
                    if (!branchName || !branchRef) {
                        console.warn(`[BitbucketEnterpriseServiceMgr][_fetchRepositories] - defaultBranch doesn't exist for ${repository.owner}/${repository.name} - it's empty repository`);
                        return;
                    }
                    repositories.push({ ...repository, defaultBranch: branchName, branchRef });
                } catch (err) {
                    console.error('[BitbucketEnterpriseServiceMgr][_fetchRepositories] - failed to get defaultBranch - repository skipped', repository, err);
                }
            })
        });
        return repositories;
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

    async getFileContent(file) {
        return await this.apiManager.getFileContent({
            projectKey: file.repo.owner,
            repositorySlug: file.repo.name,
            ref: file.branchRef,
            filePath: file.path
        });
    }

    async downloadChunkContentsAndUploadToBucket({ chunk, customerName, scannerType }) {
        console.log('[BBEnterpriseMgr][downloadChunkContentsAndUploadToBucket] - start execution');
        const { shouldClone } = chunk[0];
        console.log('[BBEnterpriseMgr][downloadChunkContentsAndUploadToBucket] - should clone chunck: ', shouldClone);
        if (shouldClone) {
            await this.cloneReposAndUploadFilesToS3({ chunk, customerName, scannerType });
        } else {
            await this.fetchIndividualFilesContentsAndUploadToBucket({
                chunk,
                customerName,
                scannerType,
                maxConcurrent: 5
            });
        }
    }

    async cloneRepository({ fullRepoName, customerName, reposFolderPath }) {
        return this.apiManager.cloneRepo({ fullRepoPath: fullRepoName, customerName, reposFolderPath });
    }

    async makePullRequest({
        customerName, owner, repoName, sourceBranchName, newFiles, // required
        commitMessage, prTitle, prBody, newBranchName // optional
    }) {
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
            projectKey: owner,
            repositorySlug: repoName,
            sourceBranchName,
            files: newFiles,
            commitMessage,
            title: prTitle,
            description: prBody,
            newBranchName
        });

        return new PullRequest({
            id: pullRequestObjResponse.id,
            webUrl: pullRequestObjResponse.links ? pullRequestObjResponse.links.self[0].href : null
        }).toJSON();
    }

    async commitAndPush({ customerName, owner, repoName, sourceBranchName, newFiles }) {
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
            projectKey: owner,
            repositorySlug: repoName,
            branchName: sourceBranchName,
            files: newFiles
        });
    }

    async _generateBCFullWebhookPath() {
        return `${this.apiGatewayUrl}${config.webHookRelativePath}`;
    }

    async _getHooksFromVCS(entity) {
        return await this.apiManager.getHooks({ projectKey: entity.owner, repositorySlug: `${entity.name}` });
    }

    _filterHooks({ hooks, BC_FULL_WEBHOOK_PATH }) {
        return hooks.filter(repoHook => repoHook.url && repoHook.url === BC_FULL_WEBHOOK_PATH);
    }

    async _deleteHooks({ bcHooks, entity }) {
        await Promise.all(bcHooks.map(hook => this.apiManager.deleteHook({ projectKey: entity.owner, repositorySlug: entity.name, id: hook.id })));
    }

    async _createHook({ entity, BC_FULL_WEBHOOK_PATH }) {
        await this.apiManager.setHook({
            projectKey: entity.owner,
            repositorySlug: entity.name,
            url: BC_FULL_WEBHOOK_PATH,
            name: config.webhookName,
            events: config.webhookEvents
        });
    }

    async handleMergedPR({ customerName, workspace, repo, pullNumber, intoBranchName, isMerged, fromBranch }) {
        const defaultBranchResponse = await this.apiManager.getDefaultBranch({ projectKey: workspace, repositorySlug: repo });
        const defaultBranch = defaultBranchResponse.branchName;
        const isMergedToDefaultBranch = isMerged && intoBranchName === defaultBranch;
        let suppressedResources;
        try {
            if (isMerged) {
                suppressedResources = await cicdRemoteLambda.invoke('CICD/handleMergedCICDRun', {
                    customerName,
                    owner: workspace,
                    repository: repo,
                    pullNumber,
                    shouldGetSuppressedResources: isMergedToDefaultBranch
                });
            }
            const status = isMerged ? PR_STATUS.MERGED : PR_STATUS.CLOSED;
            await this.updatePREntityStatus({ fromBranch, number: pullNumber, owner: workspace, repositoryName: repo, customerName, status, source: this.sourceType });
            await handleYorClosedMergedPR({
                owner: workspace,
                name: repo,
                prNumber: pullNumber,
                repositoriesApiLambda: process.env.REPOSITORIES_API_LAMBDA,
                yorPRLambdaName: process.env.YOR_PR_LAMBDA,
                isMerged
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

    async setPRCheck({ runId, commitHash, workspace, state = BITBUCKET_CHECK_STATUSES.INPROGRESS, repositoryName, detailsURL }) {
        const data = {
            key: runId,
            state,
            name: 'Bridgecrew / Infrastructure as Code analysis',
            url: detailsURL,
            description: BITBUCKET_CHECK_MESSAGES[state]
        };

        await this.apiManager.updateBuild({
            workspace,
            repositoryName,
            commitHash,
            data
        });
    }

    async _getPulRequestFiles({ workspace, repositoryName, pullRequestId }) {
        const pullRequestDiffStatResponse = await this.apiManager.getPullRequestDiffStat({ workspace, repositoryName, pullRequestId });
        const paths = pullRequestDiffStatResponse.map(prDiffObj => prDiffObj.path.toString);
        console.log(`files that have changed at the PR: ${pullRequestId} :`, paths);
        return paths;
    }

    async getChangedPRFiles({ workspace, customerName, repositoryName, pullRequestId, nodeHash }) {
        if (!this.apiManager) {
            await this.init({ customerName });
        }
        const pullRequestFiles = await this._getPulRequestFiles({ workspace, repositoryName, pullRequestId });

        const repoSettingSchema = await settingsMgrApiLambda.invoke('vcsSettings/getScheme', { customerName, fullRepoName: `${workspace}/${repositoryName}` });

        const filesWithPath = pullRequestFiles.map(filePath => ({ path: filePath }));
        const filteredFromSchemaFiles = removeExcludedFiles({ repoSettingSchema, files: filesWithPath, pathInFile: 'path', fullRepoName: `${workspace}/${repositoryName}` });
        if (!filteredFromSchemaFiles || !filteredFromSchemaFiles.length) {
            console.info('all the changed files where excluded');
            return { scanPaths: [], patchLinesToFileMapping: [] };
        }
        const filteredPaths = filteredFromSchemaFiles.map(fileWithPath => fileWithPath.path);

        const prefix = `checkov/${customerName}/${workspace}/${repositoryName}/PRs/${pullRequestId}/${nodeHash}/${SRC}`;
        await this._getFilesAndUploadToS3({ filePaths: filteredPaths, workspace, repositoryName, nodeHash, scannerType: 'checkov', prefix });
        const scanPaths = [{ owner: workspace, name: repositoryName, path: prefix, public: true }];
        // todo: create the patchLinesToFileMapping https://docs.atlassian.com/bitbucket-server/rest/6.7.1/bitbucket-rest.html#idp308
        const patchLinesToFileMapping = filteredPaths.length > 0 ? this.createPatchLinesToFileMapping({ filesPaths: filteredPaths }) : [];
        return { scanPaths, patchLinesToFileMapping };
    }

    createPatchLinesToFileMapping({ filesPaths }) { // todo
        const mapping = [];
        if (filesPaths && filesPaths.length) {
            filesPaths.forEach(file => {
                const lines = [[1, 10000]];
                mapping.push({
                    path: file,
                    lines
                });
            });
        }
        return mapping;
    }

    async _getFilesAndUploadToS3({ filePaths, workspace, repositoryName, nodeHash, prefix }) {
        // TODO: remove _getFilesAndUploadToS3 from all VCS - BCE-7326
        console.info(`getting and uploading ${filePaths.length} files...`);
        const files = await promiseAllWithRateLimit({
            arr: filePaths,
            maxConcurrent: 5,
            callback: (async path => {
                const file = new File({ path, encoding: config.encoding });
                file.content = await this.apiManager.getFileContent({
                    projectKey: workspace,
                    repositorySlug: repositoryName,
                    ref: nodeHash,
                    filePath: path
                });
                await file.save({ prefix, bucket: SCAN_RESULTS_BUCKET });
                return file;
            })
        });
        console.info(`successfully got and uploaded ${files.length} files`);
        return files;
    }

    async _updatePrCheckStatus({ customerName, owner, repo, sha, state, runNumber, detailsURL, prCheckTitle, description, manuallyPassed = false }) {
        console.log('[bitbucketEnterpriseServiceMgr][updatePrCheckStatus]', { customerName, owner, repo, detailsURL, prCheckTitle, state });
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
            console.error('[bitbucketEnterpriseServiceMgr][updatePrCheckStatus] failed to update pr check status', e);
            throw new Error('[bitbucketEnterpriseServiceMgr][updatePrCheckStatus] failed to update pr check status');
        }
    }

    async handlePullRequest({ eventType, customerName, repoSettingSchema, workspace, repositoryName, pullRequestId, nodeHash, fromBranch, intoBranch, prTitle, author, violationConfigurationsMap, scannerType, domain, isPrisma, enforcementRulesEnabled }) {
        this._createCustomLabels({ customerName });
        console.info(`handle pull request for customer: ${customerName} full repo path: ${workspace}/${repositoryName} for pull request id: ${pullRequestId} nodeHash: ${nodeHash} repoSettingSchema: ${JSON.stringify(repoSettingSchema)}`);
        if (!customerName || !workspace || !repositoryName) {
            throw new Error('Bad params, missing some required params');
        }
        if (!this.customerName) {
            await this.init({ customerName });
        }

        if (eventType === config.eventTypes.PR_CREATED || eventType === config.eventTypes.PR_UPDATED) {
            let pr = pullRequestId;
            let toBranch = intoBranch;
            let lastCommit = nodeHash;
            let prAuthor = author;
            let title = prTitle;
            let shouldCreateCICDRun = true;

            if (fromBranch.startsWith(BRANCH_PREFIXES.PLATFORM_PR_BRANCH_PREFIX)) {
                await this.createPlatformPREntity(({ fromBranch, intoBranch, customerName, owner: workspace, source: this.sourceType, repositoryName, number: pr, title: prTitle, author }));
                return;
            }
            if (fromBranch.startsWith(BRANCH_PREFIXES.YOR_PR_BRANCH_PREFIX)) {
                console.info(`Skip on PR flow since this branch name: ${fromBranch} starts with: ${BRANCH_PREFIXES.YOR_PR_BRANCH_PREFIX}`);
                return;
            }
            if (eventType === config.eventTypes.PR_UPDATED) {
                const defaultBranchResponse = await this.apiManager.getDefaultBranch({ projectKey: workspace, repositorySlug: repositoryName });
                const defaultBranch = defaultBranchResponse.branchName;
                if (fromBranch === defaultBranch) {
                    console.log('Default branch updated so we wont open CICD run for it', { eventType, customerName, workspace, repositoryName, fromBranch });
                    shouldCreateCICDRun = false;
                }

                const lastRun = shouldCreateCICDRun && await cicdRemoteLambda.invoke('CICD/getMaxRun', {
                    repository: repositoryName,
                    owner: workspace,
                    customerName,
                    fromBranch
                });
                if (lastRun && lastRun.pr) {
                    pr = lastRun.pr;
                    toBranch = lastRun.into_branch;
                    prAuthor = lastRun.author;
                    title = prTitle || lastRun.prTitle;
                    lastCommit = nodeHash || await this.apiManager.getPRLatestCommit({
                        projectKey: workspace,
                        repositorySlug: repositoryName,
                        pr
                    });
                    if (!lastCommit) {
                        console.error('Could not find the latest commit for this update webhook', {
                            customerName,
                            workspace,
                            repositoryName,
                            pr,
                            fromBranch,
                            toBranch
                        });
                        shouldCreateCICDRun = false;
                    }
                }
            }
            // Check if the commit already exists
            const existingRun = shouldCreateCICDRun && await cicdRemoteLambda.invoke('CICD/getRun', {
                repositoryName,
                repositoryOwner: workspace,
                source: SOURCE_TYPE,
                customerName,
                fromBranch,
                intoBranch: toBranch,
                pr,
                commit: lastCommit
            });
            console.log('Existing run: ', existingRun);

            if (!existingRun) {
                if (!domain) {
                    console.error('could not get detailsDomain for customer', customerName);
                    shouldCreateCICDRun = false;
                }
                if (shouldCreateCICDRun) {
                    const bitbucketCodeReviewIntegration = new BitbucketCodeReviewIntegration({
                        serviceMgr: this,
                        sourceType: SOURCE_TYPE,
                        customerName,
                        repository: repositoryName,
                        owner: workspace,
                        pr,
                        prTitle: title,
                        commit: lastCommit,
                        fromBranch,
                        intoBranch: toBranch,
                        author: prAuthor,
                        repoSettingSchema,
                        domain,
                        isPrisma,
                        enforcementRulesEnabled
                    });

                    await bitbucketCodeReviewIntegration.start();
                }
            }
        }
    }

    async getGitCloneString({ customerName, repoOwner, repoName }) {
        this.customerName = customerName;
        await this.init({ customerName });
        const httpOrHttps = this.baseURL.split('://')[0];
        return { gitCloneString: `-c "${httpOrHttps}.extraHeader=Authorization: Bearer ${this.accessToken}" ${this.baseURL}/scm/${repoOwner}/${repoName}.git` };
    }

    async createOrUpdatePRComments({ customerName, sourceId, repoConf, prData, violations, isPartialScan, patchLinesToFileMapping, module, repositoryRule }) {
        this._createCustomLabels({ customerName });
        console.log('createOrUpdatePRComments:', customerName, sourceId, repoConf, prData, JSON.stringify(violations), JSON.stringify(patchLinesToFileMapping), isPartialScan, module, repositoryRule);
        await this.init({ customerName });
        try {
            const { domain } = await settingsMgrApiLambda.invoke('vcsSettings/getCustomerPlatformBaseURL', { customerName });
            if (!domain) {
                console.error('[bitbucketEnterpriseServiceMgr][createOrUpdatePRComments] Failed to get application domain(PC or BC app url).', { customerName, domain });
                throw new Error(`[bitbucketEnterpriseServiceMgr][createOrUpdatePRComments] Failed to get application domain for customer: ${customerName}`);
            }
            const { owner, repo, pullNumber, sha } = prData;
            const reportConf = TEXT_CONFIG[module].codeReviews[SOURCE_TYPES.BITBUCKET].REPORT;
            const reportParams = {
                details: reportConf.details,
                title: reportConf.title,
                type: reportConf.type,
                reporter: reportConf.reporter,
                link: domain,
                logo_url: reportConf.getLogoURL(process.env.AWS_ACCOUNT_ID, process.env.TAG, process.env.AWS_REGION)
            };

            const reportId = `bc-report-${customerName}-${pullNumber}-${sha}`.substring(0, 50);

            const relevantComments = await this.createRelevantComments({
                violations,
                repoConf,
                customerName,
                sourceId,
                prData,
                patchLinesToFileMapping,
                module,
                repositoryRule
            });
            console.log('createOrUpdatePRComments:', { customerName }, 'relevantComments=', JSON.stringify(relevantComments));

            // remove unnecessary fields
            const annotationsTransformed = relevantComments.map(annotation => ({
                path: annotation.path,
                line: annotation.line,
                message: annotation.message,
                severity: annotation.severity,
                link: annotation.link,
                type: annotation.type,
                externalId: annotation.externalId
            }));

            console.info('createOrUpdatePRComments:', { customerName }, `isPartialScan: ${isPartialScan}`);
            if (isPartialScan) {
                // todo: consider creating the report on webhook received
                await this.apiManager.createReport({ // create or update report with his meta data
                    workspace: owner,
                    repositoryName: repo,
                    commitHash: sha,
                    reportId,
                    status: relevantComments.length ? config.reportStatus.failed : config.reportStatus.passed,
                    // data: [
                    //     { type: 'NUMBER', title: 'FAILED', value: relevantComments.length }  //todo: uncomment after filtering the irrelvant comments
                    // ],
                    reportParams
                });

                console.info('createOrUpdatePRComments:', { customerName }, { relevantComments });
                if (relevantComments.length) {
                    if (annotationsTransformed.length > 0) {
                        const chunkSize = config.annotationsMaxChunkSize;
                        if (annotationsTransformed.length > chunkSize) {
                            console.info('createOrUpdatePRComments:', { customerName }, `annotation length is: ${annotationsTransformed.length} - separate to chunks of ${chunkSize} annotations`);
                            const chunks = [];
                            for (let i = 0; i < annotationsTransformed.length; i += chunkSize) {
                                const chunk = annotationsTransformed.slice(i, i + chunkSize);
                                chunks.push(chunk);
                            }
                            for (const annotationChunk of chunks) {
                                await this.apiManager.setReportAnnotations({ workspace: owner, repositoryName: repo, commitHash: sha, reportId, annotations: annotationChunk });
                            }
                        } else {
                            await this.apiManager.setReportAnnotations({ workspace: owner, repositoryName: repo, commitHash: sha, reportId, annotations: annotationsTransformed });
                        }
                    }
                }
                const prReviewAnnotations = relevantComments.map((annotation) => ({
                    commentId: annotation.externalId,
                    violationId: annotation.violationId,
                    resourceId: annotation.resourceId
                }));

                return prReviewAnnotations;
            }
            const violationsComments = [];
            for (const annotationTransformed of annotationsTransformed) { // promise all causing failures
                const { violationId, resourceId, commentIds } = relevantComments.find(comment => comment.externalId === annotationTransformed.externalId);
                if (commentIds && commentIds.length) { // exiting annotation, can skip for now (todo: update annotation?)
                    continue;
                } else { // create new annotation
                    const reportAnnotationResponse = await this.apiManager.setReportAnnotations({ workspace: owner, repositoryName: repo, commitHash: sha, reportId, annotations: [annotationTransformed] });
                    if (reportAnnotationResponse) {
                        violationsComments.push({
                            commentId: annotationTransformed.externalId,
                            violationId,
                            resourceId
                        });
                    }
                }
            }
            return violationsComments;
        } catch (e) {
            console.error(`failed to create or update PRComments for customer ${customerName} on pr: ${JSON.stringify(prData)}`, e);
        }
    }

    async createRelevantComments({ violations, repoConf, customerName, sourceId, prData, patchLinesToFileMapping, module, repositoryRule }) {
        this._createCustomLabels({ customerName });
        const comments = [];
        await Promise.all(violations.map(async violation => {
            const indexOfSplit = violation.resource_id.indexOf(':');
            const [filePath, resource] = [
                violation.resource_id.substring(0, indexOfSplit),
                violation.resource_id.substring(indexOfSplit + 1)
            ];
            const resourceArr = resource.split('.');
            if (violation.violation_status === VIOLATION_STATUSES.OPEN
                && (
                    (!repositoryRule
                        && isViolationRelevant({ violationConfiguration: { severity: violation.severity, incidentId: violation.violation_id }, repoConf }))
                    || (repositoryRule
                        && isViolationRelevantByEnforcementRules({ repositoryRule, violationId: violation.violation_id, severity: violation.severity, customViolation: violation.isCustom, thresholdName: THRESHOLD_SEVERITY_NAMES.COMMENTS_BOT_THRESHOLD }))
                )
                && !await checkIsSuppressed({ violationId: violation.violation_id, resourceId: violation.resource_id, customerName, sourceId })) {
                // BitbucketEnterprise does not support INFO & CRITICAL so it must be LOW / MEDIUM / HIGH
                let severity;
                if (violation.severity === 'INFO') {
                    severity = 'LOW';
                } else if (violation.severity === 'CRITICAL') {
                    severity = 'HIGH';
                } else {
                    severity = violation.severity;
                }
                comments.push({
                    externalId: `BC-ANNOTATION-${SCANNER_TYPE}-${violation.framework_type}-${violation.checkId}-${filePath}-${resource}-${violation.metadata_lines}-${violation.violation_status}`,
                    type: 'VULNERABILITY',
                    message: `${violation.title} (${violation.violation_id})  | ${violation.category ? `Category: ${violation.category} | ` : ''}`
                        + `Resource: ${resourceArr[0]} ${resourceArr[1] ? `[${resourceArr[1]}]` : ''}, ${(violation.metadata_lines && Array.isArray(violation.metadata_lines)) ? `${violation.metadata_lines[0]} - ${violation.metadata_lines[1]}` : ''}`,
                    severity,
                    path: filePath.startsWith('/') ? filePath.substring(1) : filePath,
                    line: violation.metadata_lines && Array.isArray(violation.metadata_lines) ? violation.metadata_lines[0] : '',
                    link: !violation.isCustom ? violation.guideline : undefined,
                    result: violation.violation_status,
                    violationId: violation.violation_id,
                    // eslint-disable-next-line camelcase
                    resourceId: violation.resource_id,
                    commentIds: violation.comment_ids
                });
            }
        }));
        return comments;
    }

    async generateReposTokens({ customerName }) {
        await this.init({ customerName });
        const repositories = await this._getRepositories();
        const repoTokens = [];

        for (const selectedRepository of this.selectedRepositories) {
            const repository = repositories.find(repo => `${repo.owner}/${repo.name}` === selectedRepository);
            if (repository) {
                const defaultBranch = await this.apiManager.getDefaultBranch({ projectKey: repository.owner, repositorySlug: repository.name }).then(r => r.branchName || null);
                if (defaultBranch) {
                    repository.defaultBranch = defaultBranch;
                }
                repoTokens.push({ repository, serverUrl: this.baseURL, token: this.accessToken });
            }
        }
        return repoTokens;
    }
}

module.exports = {
    BitbucketEnterpriseServiceMgr
};