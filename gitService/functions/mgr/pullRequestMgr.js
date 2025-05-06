const File = require('@bridgecrew/nodeUtils/models/VersionControl/file');
const Repository = require('@bridgecrew/nodeUtils/models/VersionControl/repository');
const { promiseAllWithRateLimit } = require('@bridgecrew/nodeUtils/common/promiseAllWithRateLimit');
const { v4 } = require('uuid');
const RemoteLambda = require('@bridgecrew/nodeUtils/remoteLambda/invoke');
const { MODULE_TYPE } = require('@bridgecrew/nodeUtils/models/Enums');
const { TEXT_CONFIG } = require('@bridgecrew/nodeUtils/vcs/uiTextConfig');
const factoryVCSDefinition = require('../models/factoryVCSDefinition');

const { SCAN_RESULTS_BUCKET, INTEGRATION_API_LAMBDA } = process.env;
const integrationsRemoteLambda = new RemoteLambda(INTEGRATION_API_LAMBDA);
const settingsMgrApiLambda = new RemoteLambda(process.env.SETTINGS_MGR_API_LAMBDA);

class YorPullRequestMgr {
    constructor({ customerName, repoOwner, repoName, sourceType, s3PathObject, fromBranch }) {
        this.customerName = customerName;
        this.repoOwner = repoOwner;
        this.repoName = repoName;
        this.sourceType = sourceType;
        this.s3PathObject = s3PathObject;
        this.fromBranch = fromBranch;
        this.files = [];
        this.prParams = {};
        this.vcsDefinitionInstance = factoryVCSDefinition({ sourceType, customerName, repoOwner });

        console.info(`[YorPullRequestMgr] created with the following params: ${JSON.stringify(this)}`);
    }

    async _createFiles() {
        const s3Prefix = this.s3PathObject.prefix;
        console.info(`fetching files from s3, customer name: ${this.customerName} s3 prefix: ${s3Prefix} relative paths: ${this.s3PathObject.relativePaths}`);
        await promiseAllWithRateLimit({
            arr: this.s3PathObject.relativePaths,
            maxConcurrent: 50,
            callback: async relativePath => {
                const file = new File({
                    repo: new Repository({ owner: this.repoOwner, name: this.repoName }),
                    path: relativePath
                });
                await file.readFromS3({
                    bucket: SCAN_RESULTS_BUCKET,
                    prefix: s3Prefix,
                    encoding: this.vcsDefinitionInstance.getEncoding() // the default it utf8
                });
                this.files.push(file);
            }
        });
        console.log(`successfully fetched ${this.s3PathObject.relativePaths.length} files`);
    }

    async _getIntegrationModule() {
        if (this.customerName && this.sourceType) {
            const integrationResponse = await integrationsRemoteLambda.invoke('getByType', {
                customerName: this.customerName,
                type: this.sourceType
            });
            return integrationResponse[0]?.params?.module || MODULE_TYPE.BC;
        }
        return MODULE_TYPE.BC;
    }

    async _getPlatformDetails(customerName) {
        const { domain, isPrisma } = await settingsMgrApiLambda.invoke('vcsSettings/getCustomerPlatformBaseURL', { customerName });
        return { domain, isPrisma };
    }

    async _getYorTaggingManagementUrl(customerName) {
        console.log('[YorPullRequestMgr][_getYorTagRulesManagementUrl] - Building URL to Tag rules management', {
            customerName,
            repoName: this.repoName,
            repoOwner: this.repoOwner
        });
        const { domain, isPrisma } = await this._getPlatformDetails(customerName);
        if (!domain) {
            console.error('[YorPullRequestMgr][_getYorTagRulesManagementUrl] Failed to get application domain(PC or BC app url).', { customerName, domain });
            throw new Error(`[YorPullRequestMgr][_getYorTagRulesManagementUrl] Failed to get application domain(PC or BC app url) for customer ${customerName}.`);
        }
        let url;
        if (isPrisma) {
            console.log('[YorPullRequestMgr][_getYorTagRulesManagementUrl] - Building PC module URL.', { customerName, domain });
            url = `${domain}/projects/projects/tagManagement`;
        } else {
            console.log('[YorPullRequestMgr][_getYorTagRulesManagementUrl] - Building BC module URL.', { customerName, domain });
            url = `${domain}/projects/tagManagement`;
        }
        console.log(`[YorPullRequestMgr][_getYorTagRulesManagementUrl] - result URL: ${url}.`, { url, customerName });
        return url;
    }

    async _setPRParams() {
        const integrationModule = await this._getIntegrationModule();
        this.prParams.customerName = this.customerName;
        this.prParams.owner = this.repoOwner;
        this.prParams.repoName = this.repoName;
        this.prParams.sourceBranchName = this.fromBranch;
        this.prParams.newFiles = this.files;
        this.prParams.commitMessage = TEXT_CONFIG[integrationModule].prYorTags.commitMessage;
        this.prParams.prTitle = TEXT_CONFIG[integrationModule].prYorTags.title;
        this.prParams.newBranchName = `${TEXT_CONFIG[integrationModule].prYorTags.branchName}-${v4()}`;

        const yorTaggingManagementUrl = await this._getYorTaggingManagementUrl(this.customerName);
        console.log(`yorTagRulesLink: ${yorTaggingManagementUrl}`);
        this.prParams.prBody = TEXT_CONFIG[integrationModule].prYorTags.body(yorTaggingManagementUrl);

        const additionalPRParams = await this.vcsDefinitionInstance.addAdditionalPRParams();
        Object.assign(this.prParams, additionalPRParams);
        console.info(`pr params:\n${JSON.stringify(this.prParams)}`);
    }

    async makePullRequest() {
        await this._createFiles();
        await this._setPRParams();

        return await this.vcsDefinitionInstance.executeMakePullRequest({ prParams: this.prParams });
    }
}

module.exports = { YorPullRequestMgr };