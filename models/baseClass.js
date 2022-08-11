const AWS = require('aws-sdk');
const epsagon = require('epsagon');
const fs = require('fs');
const { execSync } = require('child_process');
const { promiseAllWithRateLimit } = require('@bridgecrew/nodeUtils/common/promiseAllWithRateLimit');
const { REPOS_SELECTION_TYPES, VCS_TRIGGER_TYPES, VCS_ERROR_CODES, VIOLATION_STATUSES, SOURCE_TYPES, RUN_RESULTS_STATUS } = require('@bridgecrew/nodeUtils/models/Enums');
const { TEXT_CONFIG } = require('@bridgecrew/nodeUtils/vcs/uiTextConfig');
const { removeExcludedFiles, isViolationRelevant } = require('@bridgecrew/nodeUtils/vcs/repoSettingSchema');
const RemoteLambda = require('@bridgecrew/nodeUtils/remoteLambda/invoke');
const { isViolationRelevantByEnforcementRules, ERROR_TYPE, FIXABLE_PACKAGES_TYPES, getFileNameFromPath } = require('@bridgecrew/vcs-utils');
const { THRESHOLD_SEVERITY_NAMES } = require('@bridgecrew/dal-layer');
const { checkFeatureFlag, FeatureFlags } = require('@bridgecrew/feature-flags');
const { getScanPathsFromS3, deleteVCSFiles, cleanFiles, createVCSFiles, checkIfFileIsValidForScan, waitForSFToComplete, BC_HOOKS_STATUS, splitFilesToChunk, saveChunksToS3, BRANCH_PREFIXES } = require('../utils/index');
const ErrorHandlingBaseClass = require('./errorHandlingBaseClass');
const { sortVulnerabilitiesBySeverity, getCveCommentMarkdownText, calculateCvesSeveritySummary } = require('../utils/index');

const S3 = new AWS.S3();

const { SCAN_RESULTS_BUCKET, PERSIST_FILES, INTEGRATION_API_LAMBDA } = process.env;
const shouldPersistFiles = PERSIST_FILES !== 'false';
const IS_LOCAL = false;
const integrationLambda = new RemoteLambda(INTEGRATION_API_LAMBDA);
const repositoriesApiLambda = new RemoteLambda(process.env.REPOSITORIES_API_LAMBDA);
const cicdRemoteLambda = new RemoteLambda(process.env.CICD_API_LAMBDA_NAME);
const cicdCveRemoteLambda = new RemoteLambda(process.env.CICD_CVE_LAMBDA);

/**
 * This is the base class of all the vcs's service mgr classes.
 * Each integrationService,js will implement some required functions (inner functions) And the BaseVCSClass will expose the public classes (e.g getRepositories, setupScan etc.)
 * For cases what we have duplicate logic (openPullRequest, updateRepositoriesWebhooks etc.) - the class will call to inner functions (see example below)
 * @deprecated soon, please make sure to update any class changes on src/packages/vcs-classes/src/models/baseClass.js
 */
class BaseVCSClass {
    constructor(sourceType) {
        console.info('[BaseVCSClass] was created.', sourceType);
        this.sourceType = sourceType;
        this.errorHandler = new ErrorHandlingBaseClass(sourceType);
        this.reposSelectionType = null;
        this.integrationId = null;
        this.updatedByPcUser = null;
        this.selectedRepositories = [];
        this.supportedMultiIntegrations = false;
        this.multiIntegrations = {};
    }

    async _getRepositoriesWithPagination({ customerName }) {
        const repositories = [];
        const LIMIT = parseInt(process.env.REPOSITORIES_PAGE_SIZE || 5000, 10);
        let repositoriesResponse = [];
        let offset = 0;
        do {
            try {
                repositoriesResponse = await repositoriesApiLambda.invoke('repositoriesService/getSelectedRepositories', {
                    customerName,
                    sourceType: this.sourceType,
                    offset,
                    limit: LIMIT
                });
            } catch (e) {
                console.error(`[BaseVCSClass][${this.sourceType}][_getRepositoriesWithPagination] - failed to get repositories for customer: ${customerName}`, { offset });
                throw e;
            }
            if (Array.isArray(repositoriesResponse) && repositoriesResponse.length > 0) {
                repositories.push(...repositoriesResponse);
            }
            offset += LIMIT;
        } while (repositoriesResponse?.length === LIMIT);
        return repositories;
    }

    async _updateIntegrationRepositories({ customerName, integrationId, reposSelectionType, timestamp, updatedByPcUser, repositories }) {
        let updateIntegrationResp = null;
        const futureRepositoriesS3Key = await this._uploadIntegrationRepositoriesToS3({
            customerName,
            integrationId,
            reposSelectionType,
            timestamp,
            repositories
        });
        if (futureRepositoriesS3Key) {
            // update repositories only when futureRepositoriesS3Key has value
            updateIntegrationResp = await this.updateIntegrationRepos(customerName, reposSelectionType, integrationId, null, updatedByPcUser, futureRepositoriesS3Key);
        }
        return updateIntegrationResp?.addedReposS3Path || null;
    }

    /**
     * Get vcs-multiple-org feature flag value
     * @param {string} customerName
     * @returns {Promise<boolean>}
     * @protected
     */
    async _isMultipleOrgFeatureFlagEnabled({ customerName }) {
        return checkFeatureFlag({
            featureFlagLambdaName: process.env.FEATURE_FLAGS_LAMBDA,
            customerName,
            defaultValue: false,
            featureFlagName: FeatureFlags.vcsMultipleOrg
        });
    }

    /**
     * Get validate-basic-token-permissions feature flag value
     * @param {string} customerName
     * @returns {Promise<boolean>}
     * @protected
     */
    async isValidateTokenBasicPermissionsFeatureFlagEnabled({ customerName }) {
        return await checkFeatureFlag({
            featureFlagLambdaName: process.env.FEATURE_FLAGS_LAMBDA,
            customerName,
            defaultValue: false,
            featureFlagName: FeatureFlags.validateTokenBasicPermissions
        });
    }

    /**
     * Create custom label in monitoring app
     * @param {object} object
     * @protected
     */
    _createCustomLabels(object) {
        for (const [key, value] of Object.entries(object)) {
            epsagon.label(key, value);
        }
    }

    /**
     * Get all user's integrations from dynamo by source
     * @param {string} customerName
     * @param {string} repositoryName
     * @returns {Promise<*[]>}
     * @protected
     */
    async _getIntegrationData({ customerName, repositoryFullName }) {
        console.info(`[BaseVCSClass][${this.sourceType}][_getIntegrationData] - getting ${customerName} integration data for repository ${repositoryFullName || 'All'}`);
        const integrations = await integrationLambda.invoke('getByType', { customerName, type: this.sourceType, filter: { repositoryFullName } });
        if (!Array.isArray(integrations) || integrations.length === 0) {
            console.warn(`[BaseVCSClass][${this.sourceType}][_getIntegrationData] - No integrations found for ${customerName} - ${this.sourceType} and repository repository ${repositoryFullName || 'All'}`);
            return [];
        }
        return integrations;
    }

    /**
     * In case of future/current repositories option - upload repositories to S3 bucket
     * @param {string} customerName
     * @param {string} integrationId
     * @param {string} reposSelectionType
     * @param {number} timestamp
     * @param {array} repositories
     * @returns {Promise<{}>}
     * @private
     */
    async _uploadIntegrationRepositoriesToS3({ customerName, integrationId, reposSelectionType, timestamp, repositories }) {
        if ([REPOS_SELECTION_TYPES.CURRENT_REPOS_PENDING, REPOS_SELECTION_TYPES.CURRENT_REPOS_AND_FUTURE].includes(reposSelectionType)
            && Array.isArray(repositories) && repositories.length > 0) {
            try {
                const s3Key = `update_integration_data/${customerName}/${this.sourceType}/${timestamp}${this.supportedMultiIntegrations ? `/${integrationId}` : ''}/all_vcs_repos.json`;
                await this._writeFileToS3({
                    Bucket: process.env.SCAN_RESULTS_BUCKET,
                    Key: s3Key,
                    Body: Buffer.from(JSON.stringify(repositories.map(repoObj => `${repoObj.owner}/${repoObj.name}`))),
                    ContentEncoding: 'base64',
                    ContentType: 'application/json'
                });
                return s3Key;
            } catch (e) {
                console.error(`[BaseVCSClass][${this.sourceType}][_uploadIntegrationRepositoriesToS3] - Failed to save file all_vcs_repos to S3 for customer ${customerName} and vcs ${this.sourceType}: ${e.message}`);
                throw e;
            }
        }
        return null;
    }

    /**
     * Get object from S3
     * @param {string} Bucket
     * @param {string} Key
     * @returns {Promise<S3.GetObjectOutput|Error>}
     * @protected
     */
    async _readFileFromS3({ Bucket, Key }) {
        return await S3.getObject({ Bucket, Key }).promise();
    }

    /**
     * Put object in S3
     * @param {S3.PutObjectRequest} params
     * @returns {Promise<S3.PutObjectOutput|Error>}}
     * @protected
     */
    async _writeFileToS3(params) {
        return await S3.putObject(params).promise();
    }

    /**
     * Parse error and declare if it's a rate limit error
     * @param {error} err
     * @returns {boolean}
     * @protected
     */
    _isRateLimitError(err) {
        const { statusCode } = this._extractDetailsFromError(err);
        return statusCode === 429;
    }

    /**
     * Create custom rate limit error for handling retry in step-functions tasks
     * @param {string} customerName
     * @returns {RateLimitError}
     * @protected
     */
    _createRateLimitError({ customerName }) {
        const source = this.sourceType;

        function RateLimitError(message) {
            this.name = 'RateLimitError';
            this.message = message;
        }

        RateLimitError.prototype = new Error();
        return new RateLimitError(`VCS ${source} error customer ${customerName} - Rate limit exceeded`);
    }

    init() {
        throw new Error('[init] - init must be implements on child class!');
    }

    commitAndPush() {
        throw new Error('[commitAndPush] - commitAndPush must be implements on child class!');
    }

    /**
     * Get settings scheme for specific repository
     * @param {string} customerName
     * @param {string} fullRepoName
     * @returns {Promise<*>}
     * @protected
     */
    async _getSchemeForRepository({ customerName, fullRepoName }) {
        const settingsMgrApiLambda = new RemoteLambda(process.env.SETTINGS_MGR_API_LAMBDA);
        const repoSettingSchema = await settingsMgrApiLambda.invoke('vcsSettings/getScheme', { customerName, fullRepoName });
        if (repoSettingSchema?.errorType) {
            const error = new Error(repoSettingSchema.errorMessage);
            error.statusCode = VCS_ERROR_CODES.UNPROCESSABLE_ENTITY;
            throw error;
        }
        return repoSettingSchema;
    }

    /**
     * Using repository scheme remove all excluded files
     * @param {string} customerName
     * @param {string} fullRepoName
     * @param {array} files
     * @returns {Promise<*>}
     * @protected
     */
    async _removeExcludedFilesByScheme({ customerName, fullRepoName, files }) {
        const repoSettingSchema = await this._getSchemeForRepository({ customerName, fullRepoName });
        return removeExcludedFiles({
            repoSettingSchema,
            files,
            fullRepoName
        });
    }

    /**
     * Get repositories from VCS
     * @returns {Promise<Repository[]|Error>}
     * @private
     */
    async _getRepositories() {
        throw new Error('[_getRepositories] - _getRepositories must be implements on child class!');
    }

    async _generateBCFullWebhookPath() {
        throw new Error('[_generateBCFullWebhookPath] - _generateBCFullWebhookPath must be implements on child class!');
    }

    _getHooksArrayForIteration() {
        return null;
    }

    async _getHooksFromVCS(entity) {
        throw new Error('[_getHooksFromVCS] - _getHooksFromVCS must be implements on child class!');
    }

    _extractDetailsFromError(err) {
        const statusCode = err?.response?.status || err?.status || err?.statusCode;
        const message = err.response?.data?.message || err?.message;
        return { message, statusCode };
    }

    async _getVCSBucketFiles({ Prefix }) {
        const results = [];
        let response;
        const params = {
            Bucket: process.env.VCS_BUCKET,
            Prefix
        };
        do {
            response = await S3.listObjectsV2(params).promise();
            const bucketContent = response?.Contents;
            if (Array.isArray(bucketContent)) {
                results.push(...bucketContent);
            }
            params.ContinuationToken = response.NextContinuationToken;
        } while (response.IsTruncated);
        return results;
    }

    async _uploadRepositoriesData({ customerName, timestamp, repositories }) {
        try {
            if (repositories.length === 0) return null;
            const s3Key = `repositories/${customerName}/${this.sourceType}/${timestamp}/repositories_for_scan.json`;
            const Expires = new Date();
            Expires.setDate(Expires.getDate() + 7);
            await this._writeFileToS3({
                Bucket: process.env.VCS_BUCKET,
                Key: s3Key,
                Body: Buffer.from(JSON.stringify(repositories), 'utf8'),
                Expires
            });
            return s3Key;
        } catch (e) {
            console.error(`[baseClass][${this.sourceType}][_uploadRepositoriesData] failed upload to S3 repositories for customer ${customerName}`, e);
            throw e;
        }
    }

    async _readS3RepositoriesData({ repositoriesS3Key, chunkOffset }) {
        console.info(`[baseClass][${this.sourceType}][_readS3RepositoriesData] trying to read repositories from s3`, { repositoriesS3Key });
        const REPOSITORIES_CHUNK_SIZE = process.env.REPOSITORIES_CHUNK_SIZE ? parseInt(process.env.REPOSITORIES_CHUNK_SIZE, 10) : 50;
        try {
            if (!repositoriesS3Key) return [];
            const rawRepositoriesData = await this._readFileFromS3({ Bucket: process.env.VCS_BUCKET, Key: repositoriesS3Key });
            const repositories = JSON.parse(rawRepositoriesData.Body.toString());
            const startPosition = chunkOffset * REPOSITORIES_CHUNK_SIZE;
            return repositories.slice(startPosition, startPosition + REPOSITORIES_CHUNK_SIZE);
        } catch (e) {
            console.error(`[baseClass][${this.sourceType}][_readS3RepositoriesData] failed to read repositories from s3`, { repositoriesS3Key }, e);
            throw e;
        }
    }

    async _uploadScanPathsS3({ customerName, timestamp, scanPaths, chunkOffset }) {
        console.log(`[baseClass][${this.sourceType}][_uploadScanPathsS3]`, { customerName, timestamp, scanPaths });
        const scanPathsS3Key = `checkov/scanPaths/${customerName}/${this.sourceType}/${timestamp}/scanPaths_${chunkOffset}.json`;
        const stringBody = typeof scanPaths === 'object' ? JSON.stringify(scanPaths) : scanPaths;
        const Expires = new Date();
        Expires.setDate(Expires.getDate() + 7);
        await this._writeFileToS3({
            Bucket: process.env.SCAN_RESULTS_BUCKET,
            Key: scanPathsS3Key,
            Body: Buffer.from(stringBody, 'utf8'),
            Expires
        });
        return scanPathsS3Key;
    }

    /**
     * Create array of chunks offsets from repositories length
     * @param {number} repositoriesLength
     * @returns {number[]}
     * @private
     */
    _createChunkOffsetArray(repositoriesLength) {
        const REPOSITORIES_CHUNK_SIZE = process.env.REPOSITORIES_CHUNK_SIZE ? parseInt(process.env.REPOSITORIES_CHUNK_SIZE, 10) : 50;
        const chunksNumber = Math.ceil(repositoriesLength / REPOSITORIES_CHUNK_SIZE);
        return Array.from(Array(chunksNumber).keys());
    }

    /**
     * Wrapper for saveChunksToS3 - use for mocking
     * @param {array} chunks
     * @param {string} customerName
     * @param {number} timestamp
     * @param {number} chunkOffset
     * @returns {Promise<string[]>}
     * @private
     */
    async _uploadChunksToS3({ chunks, customerName, timestamp, chunkOffset }) {
        return await saveChunksToS3({ chunks, customerName, timestamp, source: this.sourceType, scanResultBucket: SCAN_RESULTS_BUCKET, chunkOffset });
    }

    /**
     * Get all customer repositories for 'SyncRepositories' function
     * @param {string} customerName
     * @returns {Promise<*[]>}
     * @private
     */
    async _fetchRepositories({ customerName }) {
        console.error('[_fetchRepositories] - _fetchRepositories must be implements on child class!');
        return [];
    }

    _extractVCSParametersFromRepository({ repository }) {
        return {};
    }

    async _handleInitError({ customerName, err }) {
        console.info(`[BaseVCSClass][${this.sourceType}][_handleInitError] ignore init error handling`);
    }

    /**
     * Save repositories metadata to RDS
     * Array of repositories is created to be uploaded to S3
     * @param {string} customerName
     * @param {array} repositories
     * @returns {Promise<*[]>}
     * @private
     */
    async _enrichRepositories({ customerName, repositories }) {
        const UPDATE_REPOSITORIES_CHUNK_SIZE = 1000;
        const repositoriesForEnrichment = [];
        const repositoriesData = [];
        const dbRepositories = await this._getRepositoriesWithPagination({ customerName });
        const dbRepositoriesByOwnerAndName = dbRepositories.reduce((obj, repo) => ({ ...obj, [`${repo.owner}/${repo.repository}`]: repo }), {});
        for (const repository of repositories) {
            const params = this._extractVCSParametersFromRepository({ repository });
            const dbRepository = dbRepositoriesByOwnerAndName[`${repository.owner}/${repository.name}`];
            if (!dbRepository) {
                console.warn(`[BaseVCSClass][${this.sourceType}][_enrichRepositories] - repository: ${repository.owner} ${repository.name} ${customerName} doesn't selected for scan.`);
                continue;
            }
            repositoriesForEnrichment.push({
                customerName,
                repository: repository.name,
                owner: repository.owner,
                isPublic: repository.public,
                url: repository.url,
                defaultBranch: repository.defaultBranch,
                fork: repository.fork || false,
                source: this.sourceType,
                description: repository.description
            });
            repositoriesData.push({
                id: dbRepository.id,
                owner: repository.owner,
                name: repository.name,
                defaultBranch: repository.defaultBranch,
                isPublic: repository.public,
                url: repository.url,
                description: repository.description,
                ...params
            });
        }
        if (repositoriesForEnrichment.length) {
            const chunks = [];
            for (let i = 0; i < repositoriesForEnrichment.length; i += UPDATE_REPOSITORIES_CHUNK_SIZE) {
                const chunk = repositoriesForEnrichment.slice(i, i + UPDATE_REPOSITORIES_CHUNK_SIZE);
                chunks.push(chunk);
            }
            await promiseAllWithRateLimit({
                arr: chunks,
                maxConcurrent: 3,
                callback: async (chunk) => {
                    await repositoriesApiLambda.invoke('repositoriesService/updateRepositories', { repositories: chunk });
                }
            });
            console.info(`[BaseVCSClass][${this.sourceType}][_enrichRepositories] - ${repositoriesForEnrichment.length} repositories has been enriched`);
        }
        return repositoriesData;
    }

    _filterSelectedRepositories({ repositories }) {
        const selectedRepositories = (this.selectedRepositories || []).reduce((obj, repoFullName) => ({ ...obj, [repoFullName]: true }), {});
        return repositories.filter(repo => selectedRepositories[`${repo.owner}/${repo.name}`]);
    }

    async _getFilesStructureParameters({ customerName, repositories }) {
        console.warn('[_getFilesStructureParameters] - _getFilesStructureParameters should be implements on child class!');
        return { maxConcurrent: 1, chunkSize: 10000, extraParameters: {} };
    }

    async _fetchRepositoryFilesStructure({ customerName, scannerType, repo, extraParameters = {} }) {
        return { scanPath: null, repository: null };
    }

    _getShouldCloneValue({ fileLength }) {
        return false;
    }

    /**
     * generate access token for each selected repo
     * returns: [{repository: <Repository instance>, token: <String>}]
     */
    generateReposTokens() {
        throw new Error('[BaseVCSClass] - generateReposTokens must be implements on child class!');
    }

    /**
     * @param chunk
     * @param customerName
     * @param scannerType
     * @returns {Promise<void>}
     */
    downloadChunkContentsAndUploadToBucket({ chunk, customerName, scannerType }) {
        throw new Error('[downloadChunkContentsAndUploadToBucket] - must be implements on child class!');
    }

    /**
     * @param file
     * @returns file
     */
    normalizeFilesForSave(file) {
        throw new Error('[normalizeFilesForSave] - must be implements on child class!');
    }

    /**
     * @param fileObj
     */
    getFileContent(fileObj) {
        throw new Error('[getFileContent] - must be implements on child class!');
    }

    /**
     * @param customerName
     * @param fullRepoName: 'bridgecrewio/terragoat'
     * @param reposFolderPath: '/tmp'
     * @returns void
     */
    cloneRepository({ fullRepoName, customerName, reposFolderPath }) {
        throw new Error('[cloneRepository] - must be implements on child class!');
    }

    /**
     * @param customerName
     * @param repoOwner: 'bridgecrewio'
     * @param reposName: 'terragoat'
     * @returns object: {gitCloneString: 'sdfsdffd'}
     */

    getGitCloneString({ customerName, repoOwner, repoName }) {
        throw new Error('[getGitCloneString] - must be implements on child class!');
    }

    async saveScannedFilesToS3(scannerType, customerName, files) {
        await Promise.all(files.map(async file => {
            const prefix = `${scannerType}/${customerName}/${file.repoOwner}/${file.repoName}/${file.branch}/src`;

            const params = {
                Bucket: process.env.SCAN_RESULTS_BUCKET,
                Key: `${prefix}/${file.path}`,
                Body: Buffer.from(file.content, file.encoding)
            };

            if (file.metadata) {
                params.Metadata = file.metadata;
            }

            try {
                return await this._writeFileToS3(params);
            } catch (e) {
                console.log(`Failed to save file ${prefix}/${file.path} with content ${file.content} and encoding ${file.encoding} to S3: ${e.message}`);
                throw e;
            }
        }));
    }

    async cleanVcsFiles({ customerName, downloadFilesPaths, scannerType, scanPathsS3Key }) {
        console.log('cleanVcsFiles', { customerName, downloadFilesPaths, scannerType, scanPathsS3Key });
        let scanPaths = [];
        if (scanPathsS3Key) {
            scanPaths = await getScanPathsFromS3({ scanPathsS3Key });
        }
        if (!Array.isArray(scanPaths) || scanPaths.length === 0) return;
        console.log(`[BaseVCSClass][${this.sourceType}][cleanVcsFiles] - chunk scan paths`, scanPaths);
        const deletedFilesByRepo = await cleanFiles({ customerName, downloadFilesPaths, scanPaths, scannerType, scanResultBucket: SCAN_RESULTS_BUCKET });
        if (shouldPersistFiles && deletedFilesByRepo && deletedFilesByRepo.flat().length > 0) {
            await Promise.all(deletedFilesByRepo.map(files => deleteVCSFiles({ customerName, files: files.map(f => f.Key) })));
        }
    }

    async downloadFilesChunkAndUploadToS3({ downloadChunkPath, customerName, scannerType, scanPaths }) {
        console.info(`[BaseVCSClass][${this.sourceType}][downloadFilesChunkAndUploadToS3] - customerName: ${customerName} downloadChunkPath: ${downloadChunkPath} scannerType: ${scannerType} scanPaths: ${scanPaths}`);
        const s3Object = await S3.getObject({ Bucket: SCAN_RESULTS_BUCKET, Key: downloadChunkPath }).promise();
        const chunk = JSON.parse(s3Object.Body.toString());

        await this.init({ customerName });
        await this.downloadChunkContentsAndUploadToBucket({ chunk, customerName, scannerType });
    }

    async fetchIndividualFilesContentsAndUploadToBucket({ chunk, customerName, scannerType, maxConcurrent }) {
        const totalFiles = chunk.reduce((flat, a) => flat.concat(a.files), []);
        const failedToFetchContentFiles = [];
        console.log(`[BaseVCSClass][${this.sourceType}][fetchIndividualFilesContentsAndUploadToBucket] - downloading ${totalFiles.length} individual files for customer ${customerName}`);
        this.errorHandler.errorPhaseIncreaseTotal(this.errorHandler.DOWNLOAD_FILES_PHASE_NAME, totalFiles.length);
        await promiseAllWithRateLimit({
            arr: totalFiles,
            maxConcurrent,
            callback: async (file) => {
                try {
                    // eslint-disable-next-line no-param-reassign
                    file.content = await this.getFileContent(file);
                    if (file.content) {
                        await this.saveScannedFilesToS3(scannerType, customerName, this.normalizeFilesForSave([file]));
                    } else {
                        failedToFetchContentFiles.push(file.path);
                    }
                } catch (err) {
                    if (this._isRateLimitError(err)) {
                        console.error(`[BaseVCSClass][${this.sourceType}][fetchIndividualFilesContentsAndUploadToBucket] - Rate limit error`, err);
                        throw this._createRateLimitError({ customerName });
                    }
                    this.errorHandler.wrapErrorWithVCSData(err, customerName, { scannerType, file }, this.errorHandler.DOWNLOAD_FILES_PHASE_NAME);
                    console.error(`[BaseVCSClass][${this.sourceType}][fetchIndividualFilesContentsAndUploadToBucket] - failed to download file`, file);
                    this.errorHandler.setErrorInMonitoringApp(err);
                    failedToFetchContentFiles.push(file.path);
                }
            }
        });
        if (failedToFetchContentFiles.length) {
            console.log(`[BaseVCSClass][${this.sourceType}][fetchIndividualFilesContentsAndUploadToBucket] - failed to fetch ${failedToFetchContentFiles.length} files content for customer ${customerName}`,
                { files: failedToFetchContentFiles });
        }

        console.info(`[BaseVCSClass][${this.sourceType}][fetchIndividualFilesContentsAndUploadToBucket] - successfully downloaded ${totalFiles.length} files content - start uploading to s3...`);
        if (shouldPersistFiles) {
            await createVCSFiles({ customerName, files: totalFiles });
        }
        console.info(`[BaseVCSClass][${this.sourceType}][fetchIndividualFilesContentsAndUploadToBucket] - successfully uploaded ${totalFiles.length} files to s3`);
    }

    async cloneReposAndUploadFilesToS3({ chunk, customerName, scannerType }) {
        const reposToFilesObj = {};
        // eslint-disable-next-line guard-for-in
        for (const repo of chunk) {
            const repoName = `${repo.owner}/${repo.name}`;
            if (reposToFilesObj[repoName]) {
                reposToFilesObj[repoName] = reposToFilesObj[repoName].concat(repo.files);
            } else {
                reposToFilesObj[repoName] = repo.files;
            }
        }
        if (IS_LOCAL && !fs.existsSync('clones')) {
            fs.mkdirSync('clones');
        }

        const reposFolderPath = IS_LOCAL ? 'clones' : '/tmp';

        this.errorHandler.errorPhaseIncreaseTotal(this.errorHandler.DOWNLOAD_FILES_PHASE_NAME, Object.keys(reposToFilesObj).length);
        for (const repo in reposToFilesObj) {
            // eslint-disable-next-line no-prototype-builtins
            if (reposToFilesObj.hasOwnProperty(repo)) {
                try {
                    console.log(`[BaseVCSClass][${this.sourceType}][cloneReposAndUploadFilesToS3] - cloning repo ${repo}..`);
                    await this.cloneRepository({ fullRepoName: repo, customerName, reposFolderPath });
                    console.log(`[BaseVCSClass][${this.sourceType}][cloneReposAndUploadFilesToS3] - cloning repo ${repo} succeeded`);
                    // eslint-disable-next-line no-return-assign,no-param-reassign
                    for (const file of reposToFilesObj[repo]) {
                        const localPath = `${reposFolderPath}/${customerName}/${repo}/${file.path}`;
                        try {
                            file.content = fs.readFileSync(localPath, { encoding: 'utf8' });
                        } catch (e) {
                            console.error(`[BaseVCSClass][${this.sourceType}][cloneReposAndUploadFilesToS3] - Failed to read file ${localPath}. Skipping.`);
                        }
                    }

                    if (shouldPersistFiles) {
                        await createVCSFiles({ customerName, files: reposToFilesObj[repo] });
                    }

                    const isClone = true;
                    const normalizedFiles = this.normalizeFilesForSave(reposToFilesObj[repo], isClone);
                    await this.saveScannedFilesToS3(scannerType, customerName, normalizedFiles);

                    // eslint-disable-next-line no-param-reassign
                    delete reposToFilesObj[repo];
                } catch (err) {
                    this.errorHandler.wrapErrorWithVCSData(err, customerName, { scannerType, repo }, this.errorHandler.DOWNLOAD_FILES_PHASE_NAME);
                    console.error(`[BaseVCSClass][${this.sourceType}][cloneReposAndUploadFilesToS3] - failed to clone repository '${repo}' for customer ${customerName}`);
                    this.errorHandler.setErrorInMonitoringApp(err);
                } finally {
                    execSync(`rm -rf ${reposFolderPath}/${customerName}/${repo}`, { encoding: 'utf8', stdio: 'inherit' });
                }
            }
        }
        execSync(`rm -rf ${reposFolderPath}/${customerName}`, { encoding: 'utf8', stdio: 'inherit' });
    }

    isValidFileForScan(filePath) {
        return checkIfFileIsValidForScan(filePath);
    }

    isValidScaFileForScan(filePath) {
        return FIXABLE_PACKAGES_TYPES.includes(getFileNameFromPath(filePath));
    }

    async updateIntegrationRepos(customerName, reposSelectionType, integrationId, repositories, updatedByPcUser, allVcsReposPath) {
        console.info(`[BaseVCSClass][updateIntegrationRepos] - update integration repositories for customer: ${customerName}`, { reposSelectionType, integrationId, repositories, updatedByPcUser, allVcsReposPath });
        let updateIntegrationResp = {};
        if ((!repositories || !repositories.length) && !allVcsReposPath) {
            console.error('[BaseVCSClass][updateIntegrationRepos] - repositories cant be empty');
            return updateIntegrationResp;
        }

        if (!customerName || !integrationId) {
            throw new Error('customerName and integrationId are required');
        }

        if (reposSelectionType === REPOS_SELECTION_TYPES.CURRENT_REPOS_PENDING || reposSelectionType === REPOS_SELECTION_TYPES.CURRENT_REPOS_AND_FUTURE) {
            updateIntegrationResp = await integrationLambda.invoke('update', {
                customerName,
                id: integrationId,
                allVcsReposPath,
                params: {
                    repositories: allVcsReposPath ? null : repositories.map(repoObj => `${repoObj.owner}/${repoObj.name}`),
                    reposSelectionType: reposSelectionType === REPOS_SELECTION_TYPES.CURRENT_REPOS_PENDING ? REPOS_SELECTION_TYPES.CURRENT_REPOS : reposSelectionType
                },
                lastStatusUpdate: new Date().getTime(),
                prismaUserRoleId: updatedByPcUser && updatedByPcUser.prismaUserRoleId,
                prismaId: updatedByPcUser && updatedByPcUser.prismaId,
                isInternalInvoke: true
            });
            console.log('updateIntegrationResp', updateIntegrationResp);

            if (updateIntegrationResp.res.triggerStepFunction && updateIntegrationResp.res.triggerStepFunction.executionArn) {
                // wait for step function to finish
                await waitForSFToComplete({ executionArn: updateIntegrationResp.res.triggerStepFunction.executionArn });
                this.ready = false;
                await this.init({ customerName });
            } else {
                console.info('no repos selection was changed');
            }
        }

        return updateIntegrationResp;
    }

    _filterHooks({ hooks, BC_FULL_WEBHOOK_PATH }) {
        throw new Error('[_filterHooks] - _filterHooks must be implements on child class!');
    }

    /**
     * Delete hooks in VCS
     * @param {array} bcHooks
     * @param {object} entity
     * @returns {Promise<*>}
     * @private
     */
    async _deleteHooks({ bcHooks, entity }) {
        throw new Error('[_deleteHooks] - _deleteHooks must be implements on child class!');
    }

    /**
     * Create relevant hook in VCS
     * @param {object} entity
     * @param {string} BC_FULL_WEBHOOK_PATH
     * @returns {Promise<*>}
     * @private
     */
    async _createHook({ entity, BC_FULL_WEBHOOK_PATH }) {
        throw new Error('[_createHook] - _createHook must be implements on child class!');
    }

    async _getRepositoriesByIntegrationId() {
        throw new Error('[_getRepositoriesByIntegrationId] - _getRepositoriesByIntegrationId must be implements on child class!');
    }

    async _getHooksArrayByIntegrationId() {
        throw new Error('[_getHooksArrayByIntegrationId] - _getHooksArrayByIntegrationId must be implements on child class!');
    }

    /**
     * Identify whether entity's hooks should be created, deleted, or ignored
     * @param {array} hooks
     * @param {object} entity
     * @param {array} repositories
     * @param {array} vcsRepositories
     * @param {string} BC_FULL_WEBHOOK_PATH
     * @returns {Promise<{}>}
     * @private
     */
    async _updateVCSHooks({ hooks, entity, repositories, vcsRepositories, BC_FULL_WEBHOOK_PATH }) {
        const stats = {};
        const bcHooks = this._filterHooks({ hooks, BC_FULL_WEBHOOK_PATH });
        const fullRepoName = `${entity.owner}/${entity.name}`;
        const isRepoChosen = repositories.includes(fullRepoName);
        const hasBcHooks = Array.isArray(bcHooks) && bcHooks.length > 0;

        if (hasBcHooks && isRepoChosen) {
            // repository already has bc hooks and user want's to subscribe
            stats[fullRepoName] = BC_HOOKS_STATUS.ALREADY_EXIST;
        } else if (hasBcHooks && !isRepoChosen) {
            // repository already has bc hooks and user want's to unsubscribe
            await this._deleteHooks({ bcHooks, entity });
            stats[fullRepoName] = BC_HOOKS_STATUS.DELETED;
        } else if (!hasBcHooks && isRepoChosen) {
            // no bc hooks for that repository and user want's to subscribe
            await this._createHook({ entity, BC_FULL_WEBHOOK_PATH });
            stats[fullRepoName] = BC_HOOKS_STATUS.CREATED;
        } else if (!hasBcHooks && !isRepoChosen) {
            // no bc hooks for that repository and user want's to unsubscribe
            stats[fullRepoName] = BC_HOOKS_STATUS.DO_NOTHING;
        }
        return stats;
    }

    /**
     * Update repositories webhook according to the repositories that saved on the integration table (the repositories that the user choose)
     * @param customerName - String
     * @param repositories - Array of Strings e.g: ['livnoni/test_repo1', 'livnoni/test_repo2' ...]
     * @param integrationId
     * @returns {Promise<void>} Object that describe if the webhook ALREADY_EXIST/DELETED/CREATED/DO_NOTHING for each repository, e.g:
     *  {
     *      'livnoni/test_repo1': 'ALREADY_EXIST',
     *      'brdgecrew/test_repo2': 'DELETED',
     *      'brdgecrew/test_repo3': 'CREATED',
     *      'livnoni/test_repo4': 'DO_NOTHING',
     *  }
     */
    async updateRepositoriesWebhooks({ customerName, repositories, integrationId }) {
        console.info(`[BaseVCSClass][${this.sourceType}][updateRepositoriesWebhooks] - updating webhooks for customer: ${customerName} chosen repositories: ${repositories} for integration id: ${integrationId}`);
        let stats = {};
        const getHooksErrors = [];
        const setHooksErrors = [];
        if (!customerName) {
            throw new Error('Bad params, missing some required params');
        }
        if (!Array.isArray(repositories)) {
            throw new Error('Bad params, repositories not array!');
        }
        await this.init({ customerName });
        const BC_FULL_WEBHOOK_PATH = await this._generateBCFullWebhookPath();
        let vcsRepositories;
        let hookArray;
        if (integrationId && this.supportedMultiIntegrations) {
            vcsRepositories = await this._getRepositoriesByIntegrationId(integrationId);
            hookArray = this._getHooksArrayByIntegrationId(integrationId) || vcsRepositories;
        } else {
            vcsRepositories = await this._getRepositories();
            hookArray = this._getHooksArrayForIteration() || vcsRepositories;
        }
        await promiseAllWithRateLimit({
            arr: hookArray,
            maxConcurrent: 50,
            callback: async (entity) => {
                let hooks;
                try {
                    hooks = await this._getHooksFromVCS(entity);
                } catch (e) {
                    const { statusCode } = this._extractDetailsFromError(e);
                    if (statusCode !== 404 && statusCode !== 403) throw e;
                    switch (statusCode) {
                        case 404:
                            console.error(`[BaseVCSClass][${this.sourceType}][updateRepositoriesWebhooks] - got ${statusCode} while getting hooks - repo doesn't exist, probably deleted`, entity);
                            break;
                        case 403:
                            console.error(`[BaseVCSClass][${this.sourceType}][updateRepositoriesWebhooks] - got ${statusCode} while getting hooks - authenticated user does not have permission to install webhooks on the specified entity`, entity);
                            break;
                        default:
                            console.error(`[BaseVCSClass][${this.sourceType}][updateRepositoriesWebhooks] - got ${statusCode} while getting hooks`, entity);
                    }
                    getHooksErrors.push(e);
                    if (getHooksErrors.length >= hookArray.length) {
                        console.error(`[BaseVCSClass][${this.sourceType}][updateRepositoriesWebhooks] - got errors for entities! error logs`, getHooksErrors);
                        throw new Error('got errors for all webhook entities!');
                    }
                    return; // try to fetch the next repository hooks
                }
                try {
                    const entityStats = await this._updateVCSHooks({ hooks, entity, repositories, vcsRepositories, BC_FULL_WEBHOOK_PATH, integrationId });
                    if (Object.keys(entityStats).length > 0) {
                        stats = { ...stats, ...entityStats };
                    }
                } catch (err) {
                    setHooksErrors.push(err);
                    if (setHooksErrors.length > (0.1 * hookArray.length)) {
                        console.error(`[BaseVCSClass][${this.sourceType}][updateRepositoriesWebhooks] - got more than 10% set hooks errors for customer ${customerName}! error logs`, setHooksErrors);
                        throw new Error(`Got more than 10% set hooks errors for customer ${customerName} - ${this.sourceType}`);
                    }
                }
            }
        });
        console.log(`[BaseVCSClass][${this.sourceType}][updateRepositoriesWebhooks] - finish to subscribe / unsubscribe webhooks for customer: ${customerName} stats=`, stats);
        return stats;
    }

    /**
     * Fetch all repositories from VCS and create repositories file + offset array
     * @param {string} customerName
     * @param {string} executionTime
     * @returns {Promise<{addedReposS3Path: (*|null), repositoriesS3Key: string, chunksOffsetArray: number[]}|{addedReposS3Path: null, repositoriesS3Key: null, chunksOffsetArray: *[]}>}
     */
    async syncRepositories({ customerName, executionTime }) {
        console.info(`[BaseVCSClass][${this.sourceType}][syncRepositories] - customer name: ${customerName}`, executionTime);
        this._createCustomLabels({ customerName });
        const timestamp = new Date(executionTime).getTime();
        const defaultValue = {
            timestamp,
            source: this.sourceType,
            addedReposS3Path: null,
            repositoriesS3Key: null,
            chunksOffsetArray: []
        };
        let isInitSuccess = false;
        try {
            isInitSuccess = await this.init({ customerName });
        } catch (err) {
            console.error(`[BaseVCSClass][${this.sourceType}][syncRepositories] - error`, { customerName }, err);
            if (!this.supportedMultiIntegrations) {
                await this._handleInitError({ customerName, err });
            }
            throw err;
        }
        if (!isInitSuccess) {
            return defaultValue;
        }
        let repositories = [];
        let duplicateRepositoriesByIntegrationId = {};
        if (this.supportedMultiIntegrations) {
            const response = await this._fetchRepositories({ customerName });
            repositories = response?.repositories || [];
            duplicateRepositoriesByIntegrationId = response?.duplicateRepositoriesByIntegrationId || {};
        } else {
            repositories = await this._fetchRepositories({ customerName });
        }
        if (!Array.isArray(repositories) || repositories.length === 0) {
            return defaultValue;
        }
        repositories = this._filterUniqueRepositories({ repositories });
        console.info(`[BaseVCSClass][${this.sourceType}][syncRepositories] - '${repositories.length}' repositories for ${customerName} are: ${JSON.stringify(repositories)}`);
        let addedReposS3Path = null;
        if (this.supportedMultiIntegrations) {
            const promises = [];
            for (const [integrationId, integrationData] of Object.entries(this.multiIntegrations)) {
                const { reposSelectionType, updatedByPcUser } = integrationData;
                const duplicateRepositories = duplicateRepositoriesByIntegrationId[integrationId] || [];
                const integrationRepositories = repositories.filter(repo => repo.integrationId === integrationId || duplicateRepositories.includes(`${repo.owner}/${repo.name}`));
                promises.push(this._updateIntegrationRepositories({
                    customerName,
                    integrationId,
                    reposSelectionType,
                    timestamp,
                    updatedByPcUser,
                    repositories: integrationRepositories
                }));
            }
            const addedReposS3Paths = await Promise.all(promises);
            addedReposS3Path = await this._combineAddedRepositories({ customerName, reposSelectionType: 'COMBINED', addedReposS3Paths });
        } else {
            addedReposS3Path = await this._updateIntegrationRepositories({
                customerName,
                integrationId: this.integrationId,
                reposSelectionType: this.reposSelectionType,
                timestamp,
                updatedByPcUser: this.updatedByPcUser,
                repositories
            });
        }
        // filter only selected repositories
        repositories = this._filterSelectedRepositories({ repositories });
        console.info(`[BaseVCSClass][${this.sourceType}][syncRepositories] - '${repositories.length}' repositories to scan are: ${JSON.stringify(repositories)}`);
        const repositoriesData = await this._enrichRepositories({ customerName, repositories });
        const repositoriesS3Key = await this._uploadRepositoriesData({ customerName, timestamp, repositories: repositoriesData });
        const chunksOffsetArray = this._createChunkOffsetArray(repositoriesData.length);
        return {
            timestamp,
            source: this.sourceType,
            addedReposS3Path,
            repositoriesS3Key,
            chunksOffsetArray
        };
    }

    _extractOwnerAndRepoNameFromFullRepoName(fullRepoName) {
        if (!fullRepoName) return {};
        const splittedFullRepoName = fullRepoName.split('/');
        const repositoryName = splittedFullRepoName.pop();
        const owner = splittedFullRepoName.join('/');
        return { owner, repositoryName };
    }

    /**
     * Get chunk of repositories from S3 file and fetch files structure for each repository
     * @param {string} customerName
     * @param {string} scannerType
     * @param {string} executionTime
     * @param {number} chunkOffset
     * @param {string|null} addedReposS3Path
     * @param {string|null} repositoriesS3Key
     */
    async getRepositoriesFilesStructure({ customerName, scannerType, executionTime, chunkOffset, addedReposS3Path, repositoriesS3Key }) {
        console.info(`[BaseVCSClass][${this.sourceType}][getRepositoriesFilesStructure] - customer name: ${customerName} scannerType: ${scannerType}`, { executionTime, addedReposS3Path, repositoriesS3Key });
        this._createCustomLabels({ customerName, scannerType });
        const timestamp = new Date(executionTime).getTime();
        const executionDate = new Date(executionTime);
        const scanPaths = [];
        const noRelevantFilesRepos = [];
        const reposToFilesArr = [];
        const defaultValue = {
            scannerType,
            triggerType: VCS_TRIGGER_TYPES.PERIODIC,
            source: this.sourceType,
            timestamp,
            addedReposS3Path,
            chunkOffset,
            downloadFilesPaths: [],
            isPathsArrayEmpty: true,
            scanPathsS3Key: null
        };
        try {
            const isInitSuccess = await this.init({ customerName });
            if (!isInitSuccess || !repositoriesS3Key) return defaultValue;
            const repositories = await this._readS3RepositoriesData({ repositoriesS3Key, chunkOffset });
            if (!Array.isArray(repositories) || repositories.length === 0) {
                return defaultValue;
            }
            const { maxConcurrent, chunkSize, extraParameters } = await this._getFilesStructureParameters({ customerName, repositories });
            this.errorHandler.errorPhaseIncreaseTotal(this.errorHandler.GET_REPOSITORIES_FILES_STRUCTURE_PHASE_NAME, repositories.length);
            await promiseAllWithRateLimit({
                arr: repositories,
                callback: async (repo) => {
                    const { scanPath, repository } = await this._fetchRepositoryFilesStructure({ customerName, scannerType, repo, extraParameters });
                    if (scanPath && repository) {
                        scanPaths.push(scanPath);
                        reposToFilesArr.push(repository);
                    } else {
                        noRelevantFilesRepos.push({ repository: repo.name, source: this.sourceType, customerName, owner: repo.owner, lastScanDate: executionDate });
                    }
                },
                maxConcurrent
            });
            const fileLength = reposToFilesArr.reduce((flat, a) => flat.concat(a.files), []).length;
            const shouldClone = this._getShouldCloneValue({ fileLength });
            const chunks = splitFilesToChunk({ reposToFilesArr, chunkSize, shouldClone });
            const downloadFilesPaths = await this._uploadChunksToS3({ chunks, customerName, timestamp, chunkOffset });
            console.log(`[BaseVCSClass][${this.sourceType}][getRepositoriesFilesStructure] - downloadFilesPaths`, downloadFilesPaths);
            let scanPathsS3Key = null;
            if (scanPaths.length > 0) {
                scanPathsS3Key = await this._uploadScanPathsS3({
                    customerName,
                    timestamp,
                    scanPaths,
                    chunkOffset
                });
            }
            console.log(`[BaseVCSClass][${this.sourceType}][getRepositoriesFilesStructure] - scanPathsS3Key`, scanPathsS3Key);
            await repositoriesApiLambda.invoke('repositoriesService/saveRepositories', { repositories: noRelevantFilesRepos });
            return {
                ...defaultValue,
                downloadFilesPaths,
                isPathsArrayEmpty: scanPathsS3Key === null,
                scanPathsS3Key
            };
        } catch (err) {
            console.error(`[BaseVCSClass][${this.sourceType}][getRepositoriesFilesStructure] - error`, err);
            throw err;
        }
    }

    async updatePREntityStatus({ fromBranch, number, owner, repositoryName, customerName, status, source }) {
        console.info(`updatePREntities for customer name: ${customerName} repository:${repositoryName} prNumber: ${number}`);
        const repositoryModel = await repositoriesApiLambda.invoke('repositoriesService/getRepositoryByFullNameAndSource', {
            owner,
            name: repositoryName,
            customerName,
            source
        });
        if (fromBranch.startsWith(BRANCH_PREFIXES.PLATFORM_PR_BRANCH_PREFIX)) {
            await cicdRemoteLambda.invoke('prs/updatePlatformPR', { number, repoId: repositoryModel.id, status });
        } else if (!fromBranch.startsWith(BRANCH_PREFIXES.YOR_PR_BRANCH_PREFIX)) {
            await cicdRemoteLambda.invoke('prs/updateCustomerPR', { number, repoId: repositoryModel.id, status });
        }
    }

    async createPlatformPREntity({ fromBranch, intoBranch, customerName, owner, source, repositoryName, number, title, author }) {
        console.info(`will create branches & platform pr entities for branch: ${fromBranch} customer name: ${customerName}`);
        try {
            const branches = [{
                branchName: intoBranch,
                customerName,
                owner,
                repositoryName,
                source
            }, {
                branchName: fromBranch,
                customerName,
                owner,
                repositoryName,
                source
            }];
            const branchesModels = await cicdRemoteLambda.invoke('CICD/saveBranches', branches);
            const { repoId: repositoryId, id: intoBranchId } = branchesModels.generatedMaps[0];
            const { id: fromBranchId } = branchesModels.generatedMaps[1];
            await cicdRemoteLambda.invoke('prs/upsertPlatformPR', {
                number,
                intoBranchId,
                fromBranchId,
                title,
                author,
                repoId: repositoryId
            });
        } catch (e) {
            console.warn(`Failed to create platform PR - missing repository. customerName: ${customerName}  repository: ${repositoryName}source: ${this.sourceType}`, e);
        }
    }

    async createVcsScaPrComments() {
        throw new Error('[baseClass][createVcsScaPrComments] - must be implements on child class!');
    }

    async getCommitObject() {
        throw new Error('[baseClass][getCommitObject] - must be implements on child class!');
    }

    async getErrorsByRunId({ customerName, runId, errorType }) {
        let errors = [];
        switch (ERROR_TYPE[errorType]) {
            case ERROR_TYPE.VIOLATION:
                errors = await cicdRemoteLambda.invoke('CICD/getRunViolations', {
                    customerName, status: VIOLATION_STATUSES.OPEN, id: runId
                });
                break;
            case ERROR_TYPE.CVE:
                errors = await cicdCveRemoteLambda.invoke('cicd-cve/getCvesByRunIdGroupedByPackages', { violationStatus: VIOLATION_STATUSES.OPEN, runId });
                break;
            default:
                console.error('error type is not supported', { customerName, runId, errorType });
                return [];
        }
        return errors;
    }

    async diffPrComments({ newViolations, previousViolations, commit, commitMessage }) {
        console.log('[Baseclass][diffPrComments]', { newViolations, previousViolations, commit, commitMessage });
        const result = {
            skipCommentsViolations: [],
            fixedCommentsViolations: [],
            createCommentsViolations: []
        };
        const createViolationMap = (violations) => {
            const violationsMap = {};
            violations.forEach(violation => {
                violationsMap[`${violation.violation_id}_${violation.resource_id}`] = violation;
            });

            return violationsMap;
        };
        const newViolationsMap = createViolationMap(newViolations);
        const previousViolationsMap = createViolationMap(previousViolations);

        newViolations.forEach(violation => {
            const matchingOldViolation = previousViolationsMap[`${violation.violation_id}_${violation.resource_id}`];
            if (matchingOldViolation) result.skipCommentsViolations.push(matchingOldViolation);
            else result.createCommentsViolations.push(violation);
        });

        previousViolations.forEach(prevViolation => {
            const fixedViolation = newViolationsMap[`${prevViolation.violation_id}_${prevViolation.resource_id}`];
            if (!fixedViolation) result.fixedCommentsViolations.push({ ...prevViolation, fixed: true, commit, commitMessage });
        });

        return result;
    }

    async diffScaPrComments({ newCvesByPackages, previousCvesByPackages }) {
        console.log('[Baseclass][diffScaPrComments]', { newCvesByPackages, previousCvesByPackages });
        const isSameCve = (cveA, cveB) => cveA.cveId === cveB.cveId && cveA.cveStatus === cveB.cveStatus && cveA.packageVersion === cveB.packageVersion;
        const result = {
            skipCommentsCvesByPackage: [],
            createCommentsCvesByPackage: [],
            fixedCommentsCvesByPackage: []
        };
        const createCvesByPackagesMap = (cveByPackage) => {
            const cveByPackageMap = {};
            cveByPackage.forEach(p => {
                cveByPackageMap[`${p.resourceId}_${p.packageName}`] = p;
            });

            return cveByPackageMap;
        };
        const newCvesByPackagesMap = createCvesByPackagesMap(newCvesByPackages);
        const previousCvesByPackagesMap = createCvesByPackagesMap(previousCvesByPackages);

        newCvesByPackages.forEach(newCveByPackage => {
            const newCves = newCveByPackage.cves;
            const matchingPreviosCvesByPackage = previousCvesByPackagesMap[`${newCveByPackage.resourceId}_${newCveByPackage.packageName}`]?.cves;
            if (!matchingPreviosCvesByPackage) {
                result.createCommentsCvesByPackage.push(newCveByPackage);
                return;
            }
            const shouldCreateCves = newCves.some(cve => {
                if (matchingPreviosCvesByPackage.every(prevCve => !isSameCve(cve, prevCve))) {
                    result.createCommentsCvesByPackage.push(newCveByPackage);
                    return true;
                }
                return false;
            });
            if (!shouldCreateCves) {
                const cvesToUpdateWithCommentId = {};
                const prevCommentId = matchingPreviosCvesByPackage.find(c => c?.commentIds?.length)?.commentIds;
                if (!prevCommentId) {
                    result.createCommentsCvesByPackage.push(newCveByPackage);
                } else {
                    newCves.forEach(cve => { cvesToUpdateWithCommentId[cve.id] = prevCommentId; });
                    result.skipCommentsCvesByPackage.push(cvesToUpdateWithCommentId);
                }
            }
        });
        previousCvesByPackages.forEach(prevCveByPackage => {
            const previosCves = prevCveByPackage.cves;
            const newCves = newCvesByPackagesMap[`${prevCveByPackage.resourceId}_${prevCveByPackage.packageName}`]?.cves;
            if (!newCves) return;
            previosCves.some(cve => {
                if (newCves.every(newCve => !isSameCve(cve, newCve))) {
                    result.fixedCommentsCvesByPackage.push(prevCveByPackage);
                    return true;
                }
                return false;
            });
        });

        return result;
    }

    async getDiffComments({ data, errorType }) {
        console.log('[BaseVcsClass][getDiffComments]', { errorType, data });
        const smartToUpperCase = (word) => word.replace(/[a-z]+([A-Z]+)[a-z]+/, (str, g1) => str.replace(g1, `_${g1}`)).toUpperCase();
        const GITHUB_ONLY = [smartToUpperCase(SOURCE_TYPES.GITHUB), smartToUpperCase(SOURCE_TYPES.GITHUB_ENTERPRISE)];
        const INTERACTIVE_COMMENTS_SOURCE_TYPES = [
            ...GITHUB_ONLY,
            smartToUpperCase(SOURCE_TYPES.GITLAB),
            smartToUpperCase(SOURCE_TYPES.GITLAB_ENTERPRISE)
        ];
        const resultAttributeNameByError = {
            [ERROR_TYPE.VIOLATION]: 'Violations',
            [ERROR_TYPE.CVE]: 'CvesByPackage'
        };
        try {
            const newErrors = await this.getErrorsByRunId({ customerName: data.customerName, runId: data.runId, errorType });
            console.log('newErrors: ', newErrors);
            const result = {
                [`createComments${resultAttributeNameByError[errorType]}`]: newErrors,
                [`skipComments${resultAttributeNameByError[errorType]}`]: [],
                [`fixedComments${resultAttributeNameByError[errorType]}`]: []
            };

            if (!INTERACTIVE_COMMENTS_SOURCE_TYPES.includes(data.sourceType)) {
                return { ...data, ...result };
            }
            const { id } = await cicdRemoteLambda.invoke('CICD/getPreviousRunPerPr', { id: data.runId });
            console.log('previousRunId', id);
            if (GITHUB_ONLY.includes(data.sourceType)) {
                const commitObject = await this.getCommitObject({
                    customerName: data.customerName,
                    installationId: data.installationId,
                    owner: data.runData.owner,
                    repoName: data.repository,
                    sha: data.runData.commit
                });
                console.log('commitObject', commitObject);
                // eslint-disable-next-line no-param-reassign
                [data.runData.commitMessage] = (commitObject.message || '').split('\n');
            }
            if (!id) {
                console.log('first run, no need to diff comments');
                return { ...data, ...result };
            }
            const previousErrors = await this.getErrorsByRunId({ customerName: data.customerName, runId: id, errorType });
            let diffCommentResult;
            switch (ERROR_TYPE[errorType]) {
                case ERROR_TYPE.VIOLATION:
                    diffCommentResult = await this.diffPrComments({ newViolations: newErrors, previousViolations: previousErrors, commit: data.runData.commit, commitMessage: data.runData.commitMessage });
                    break;
                case ERROR_TYPE.CVE:
                    diffCommentResult = await this.diffScaPrComments({ newCvesByPackages: newErrors, previousCvesByPackages: previousErrors });
                    break;
                default:
                    console.error('vulnerability type is not supported', { customerName: data.customerName, runId: data.runId });
                    return { ...data, ...result };
            }

            console.log('result', JSON.stringify(diffCommentResult));
            return { ...data, ...diffCommentResult };
        } catch (err) {
            console.error('[Baseclass][getDiffComments] for customer: ', data.customerName, 'run id: ', data.runId, 'with error: ', JSON.stringify(err));
        }
    }

    async createScaPRComments({
        customerName,
        installationId,
        cvesByPackage,
        patchLinesToFileMapping,
        repositoryRule,
        prData,
        repoConf,
        isPartialScan,
        module,
        mergeRequestIId
    }) {
        console.log('[Baseclass][createScaPRComments]', {
            customerName,
            cvesByPackage,
            installationId,
            prData,
            repoConf,
            isPartialScan,
            module
        });
        try {
            const scaComments = [];
            await Promise.all(cvesByPackage.map(packageData => {
                const fileName = packageData.resourceId.split('/').pop();
                const filePath = packageData.resourceId?.startsWith('/') ? packageData.resourceId.substring(1) : packageData.resourceId;
                const changedLinesPrFile = patchLinesToFileMapping.find(({ path }) => filePath === path);
                if (!changedLinesPrFile) {
                    console.warn('Cant comment on this package because it is not in the pr files', JSON.stringify(packageData));
                    return [];
                }
                const cves = packageData.cves.filter(cve => (
                    (!repositoryRule
                        && isViolationRelevant({ violationConfiguration: { severity: cve.severity, incidentId: cve.violationId }, repoConf }))
                    || (repositoryRule
                        && isViolationRelevantByEnforcementRules({ repositoryRule, violationId: cve.violationId, severity: cve.severity, customViolation: false, thresholdName: THRESHOLD_SEVERITY_NAMES.COMMENTS_BOT_THRESHOLD }))
                ));
                if (cves?.length) {
                    const sortedCvesBySeverity = sortVulnerabilitiesBySeverity(cves);
                    const firstChangedLineToCommit = changedLinesPrFile.lines[0][0];
                    const { oldPath } = changedLinesPrFile;
                    const cvesToUpdate = cves.reduce((result, cve) => {
                        if (!cve?.commentIds?.length) result.push(cve.id);
                        return result;
                    }, []);
                    const newComment = getCveCommentMarkdownText({
                        ...calculateCvesSeveritySummary(cves),
                        cveData: sortedCvesBySeverity,
                        packageName: packageData.packageName,
                        packageVersion: packageData.packageVersion,
                        fileName,
                        projectScreenLink: prData.projectScreenLink });
                    scaComments.push({
                        comment: {
                            body: newComment,
                            path: filePath,
                            side: 'RIGHT',
                            line: firstChangedLineToCommit,
                            oldPath // for gitlab
                        },
                        cvesId: cves.map(cve => cve.id),
                        commentIds: cves.find(cve => cve?.commentIds?.length)?.commentIds,
                        updateCveCommentId: cvesToUpdate
                    });
                }
            }));
            return this.createVcsScaPrComments({ isPartialScan, customerName, prData, module, installationId, scaComments, mergeRequestIId });
        } catch (e) {
            console.error('[baseClass][createScaPRComments]:', `failed to create or update PRComments for customer ${customerName} on pr: ${JSON.stringify(prData)}`, e);
        }
    }

    getRelevantLine({ lines, path, patchLinesToFileMapping }) {
        const mapping = patchLinesToFileMapping.find(element => element.path === path);
        if (!mapping) {
            return -1;
        }
        let i;
        for (i = 0; i < mapping.lines.length; i++) {
            const rangeOfVisualizeLines = mapping.lines[i];
            if (lines[0] > rangeOfVisualizeLines[1]) { // maybe next rangeOfVisualizeLines will suite
                continue;
            }
            if (lines[1] < rangeOfVisualizeLines[0]) { // we pass this lines with no match
                return -1;
            }
            if (lines[0] >= rangeOfVisualizeLines[0] && lines[0] <= rangeOfVisualizeLines[1]) { // in the middle of a visualize - comment on the top of the resource
                return lines[0];
            }
            if (lines[0] < rangeOfVisualizeLines[0] && lines[1] >= rangeOfVisualizeLines[0]) { // resource is partly visualize - comment on top of the visualize part
                return rangeOfVisualizeLines[0];
            }
        }
        return -1;
    }

    async getRelevantResources({ resources, patchLinesToFileMapping }) {
        const relevantResources = [];
        for (const resource of resources) {
            const path = resource.file.startsWith('/') ? resource.file.substr(1) : resource.file;
            const line = this.getRelevantLine({ lines: resource.lines, path, patchLinesToFileMapping });
            if (line !== -1) {
                resource.vcsCommentLine = line;
                relevantResources.push(resource);
            }
        }
        return relevantResources;
    }

    async _combineAddedRepositories({ customerName, reposSelectionType, addedReposS3Paths = [] }) {
        const filterAddedReposS3Paths = addedReposS3Paths.filter(s3Path => !!s3Path); // remove nulls
        if (filterAddedReposS3Paths.length === 0) return null;
        if (filterAddedReposS3Paths.length === 1) return filterAddedReposS3Paths[0];
        let repositories = await Promise.all(filterAddedReposS3Paths.map(async addedReposS3Path => {
            const rawAddedReposData = await this._readFileFromS3({ Bucket: process.env.SCAN_RESULTS_BUCKET, Key: addedReposS3Path });
            const { addedRepos } = JSON.parse(rawAddedReposData.Body.toString());
            return addedRepos;
        }));
        repositories = repositories.flat();
        const timestamp = new Date().getTime();
        const addedReposS3Path = `customers_added_repos_to_notify_pc/${customerName}/${this.sourceType}/${timestamp}/${reposSelectionType}/added_repos.json`;
        await this._writeFileToS3({
            Bucket: process.env.SCAN_RESULTS_BUCKET,
            Key: addedReposS3Path,
            Body: Buffer.from(JSON.stringify({ addedRepos: repositories })),
            ContentEncoding: 'base64',
            ContentType: 'application/json'
        });
        return addedReposS3Path;
    }

    _getRepositoryUniqueIdentifier({ repository }) {
        return `${repository.owner}_${repository.name}_${repository.defaultBranch}`;
    }

    _filterUniqueRepositories({ repositories }) {
        const uniqueRepositories = [];
        const seenRepositoriesIdentifiers = new Set();
        repositories.forEach(repository => {
            const uniqueKey = this._getRepositoryUniqueIdentifier({ repository });
            if (seenRepositoriesIdentifiers.has(uniqueKey)) {
                return;
            }
            seenRepositoriesIdentifiers.add(uniqueKey);
            uniqueRepositories.push(repository);
        });
        return uniqueRepositories;
    }

    async updatePrCheckStatus({ customerName, owner, repo, sha, state, pullNumber, runNumber, installationId, detailsURL, prCheckTitle, projectId, runId, manuallyPassed = false }) {
        this._createCustomLabels({ customerName });
        await this.init({ customerName });
        const description = this._getPrStatusDescription({ state, manuallyPassed });
        await this._updatePrCheckStatus({ customerName, owner, repo, sha, state, pullNumber, runNumber, installationId, detailsURL, prCheckTitle, projectId, runId, description, manuallyPassed });
    }

    _getPrStatusDescription({ state, manuallyPassed }) {
        if (manuallyPassed && state === RUN_RESULTS_STATUS.SUCCESS[this.sourceType]) {
            return TEXT_CONFIG[this.module].prDescription[this.sourceType].MANUALLY_PASSED;
        } if (state === RUN_RESULTS_STATUS.ERROR[this.sourceType]) {
            return TEXT_CONFIG[this.module].prDescription[this.sourceType].FAILED_SCAN;
        }
        return TEXT_CONFIG[this.module].prDescription[this.sourceType].DEFAULT_DESCRIPTION;
    }
}

module.exports = BaseVCSClass;