const BaseCodeReviewIntegration = require('@bridgecrew/nodeUtils/CodeReviewIntegration/index');
const Joi = require('joi');

const BaseCodeReviewBitbucketIntegrationSchema = Joi.object({
    apiManager: Joi.object().required(),
    org: Joi.string().required(),
    projectId: Joi.string().required(),
    repoId: Joi.string().required()
});

class AzureReposCodeReviewIntegration extends BaseCodeReviewIntegration {
    constructor({ apiManager, sourceType, customerName, repository, owner, pr, prTitle, commit, fromBranch, intoBranch, author, repoSettingSchema, domain, isPrisma, org, projectId, repoId, isNewCommitToPR, enforcementRulesEnabled }) {
        const bodyValidationError = BaseCodeReviewBitbucketIntegrationSchema.validate({ apiManager, org, projectId, repoId }).error;

        if (bodyValidationError) {
            const msg = `constructor params does not contain all the needed attributes: ${bodyValidationError}`;
            console.error(msg);
            throw new Error(msg);
        }
        super({ customerName, repository, sourceType, owner, pr, prTitle, commit, fromBranch, intoBranch, author, repoSettingSchema, domain, isPrisma, isNewCommitToPR, enforcementRulesEnabled });
        this.apiManager = apiManager;
        this.org = org;
        this.projectId = projectId;
        this.repoId = repoId;
    }

    getAdditionalSFParams() {
        return {
            org: this.org,
            projectId: this.projectId,
            repoId: this.repoId
        };
    }

    async postCreateCICDRun() {
        await this.apiManager.setPullRequestStatus({
            org: this.org,
            projectId: this.projectId,
            repoId: this.repoId,
            pr: this.pr,
            data: {
                context: {
                    genre: this.prCheckTitle,
                    name: this.prCheckTitle
                },
                description: 'Infrastructure as Code analysis',
                state: 'pending',
                targetUrl: this.detailsURL
            }
        });
    }
}

module.exports = AzureReposCodeReviewIntegration;