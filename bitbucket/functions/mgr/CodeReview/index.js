const BaseCodeReviewIntegration = require('@bridgecrew/nodeUtils/CodeReviewIntegration/index');
const { SOURCE_TYPES } = require('@bridgecrew/nodeUtils/models/Enums');
const Joi = require('joi');

const BaseCodeReviewBitbucketIntegrationSchema = Joi.object({
    serviceMgr: Joi.object().required()
});

class BitbucketCodeReviewIntegration extends BaseCodeReviewIntegration {
    constructor({ serviceMgr, sourceType, customerName, repository, owner, pr, prTitle, commit, fromBranch, intoBranch, author, repoSettingSchema, domain, isPrisma, enforcementRulesEnabled }) {
        const bodyValidationError = BaseCodeReviewBitbucketIntegrationSchema.validate({ serviceMgr }).error;

        if (bodyValidationError) {
            const msg = `constructor params does not contain all the needed attributes: ${bodyValidationError}`;
            console.error(msg);
            throw new Error(msg);
        }
        super({ customerName, repository, sourceType, owner, pr, prTitle, commit, fromBranch, intoBranch, author, repoSettingSchema, domain, isPrisma, enforcementRulesEnabled });
        this.serviceMgr = serviceMgr;
        this.fromBranch = fromBranch;
        this.intoBranch = intoBranch;
        this.author = author;
        this.commitHash = commit;
        this.owner = owner;
        this.pullRequestId = pr;
        this.repositoryName = repository;
        this.customerName = customerName;
    }

    async postCreateCICDRun() {
        return await this.serviceMgr.setPRCheck({
            commitHash: this.commitHash,
            workspace: this.owner,
            pullRequestId: this.pullRequestId,
            repositoryName: this.repositoryName,
            runId: this.runId,
            runNumber: this.runNumber,
            detailsURL: this.detailsURL,
            prCheckTitle: this.prCheckTitle
        });
    }
}

module.exports = BitbucketCodeReviewIntegration;