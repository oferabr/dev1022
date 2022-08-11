const AWS = require('aws-sdk');
const { URL } = require('url');
const Joi = require('joi');
const { ViolationsService } = require('@bridgecrew/dal-layer');
const { FactoryBadge, MAP_BADGE_TITLE_TO_ID, BADGE_ID_MAP } = require('../generator');
const ssmMgr = require('./ssm/ssmMgr');
const config = require('../config');

const ssmMgrInstance = ssmMgr.getInstance();

const { BADGES_S3_BUCKET_NAME } = process.env;

const badgesBodySchema = Joi.object({
    customerName: Joi.string().required(),
    ownerName: Joi.string().required(),
    vcs: Joi.string().required(),
    repositoryName: Joi.string().required(),
    isPublic: Joi.boolean()
});

const deleteRepositoryObj = Joi.object().keys({
    owner: Joi.string().optional(),
    name: Joi.string().optional(),
    fullRepoPath: Joi.string().optional()
});

const deleteBadgesBodySchema = Joi.object({
    vcs: Joi.string().required(),
    repositories: Joi.array().items(deleteRepositoryObj).required()
});

const GENERAL_BADGES = {
    INFRASTRUCTURE_SECURITY: 'Infrastructure Security'
};

const S3 = new AWS.S3();
const MAX_FILES_TO_DELETE_CHUNK = 1000;

class BadgesService {
    constructor() {
        this.violationsService = new ViolationsService();
    }

    async get({ vcs, repoOwner, repoName, branchName }) {
        // todo: support branchName (in the future)
        const response = {
            vcs,
            badges: []
        };

        const fullRepo = `${repoOwner}/${repoName}`;

        const domainUrl = await ssmMgrInstance.getDomainUrl();

        const params = {
            Bucket: BADGES_S3_BUCKET_NAME,
            Prefix: `badges/${vcs}/${fullRepo}`.toLowerCase()
        };
        const listObjects = await S3.listObjects(params).promise();
        const s3Contents = listObjects.Contents;

        if (s3Contents.length === 0) {
            console.info(`no badges for prefix: ${listObjects.Prefix}`);
            return response;
        }

        const region = process.env.AWS_REGION;
        const baseSvgUrl = `${domainUrl.endsWith('bridgecrew.cloud') ? `${domainUrl}` : `https://${listObjects.Name}.s3-${region}.amazonaws.com`}`;

        response.badges = this._createBadgesResponseFromS3Contents({ s3Contents, domainUrl, baseSvgUrl, fullRepo, vcs });
        response.lastModified = new Date(s3Contents[0].LastModified).getTime();

        return response;
    }

    /**
     *
     * @param s3Contents - Array of objects: the S3 response.Contents (https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/S3.html#listObjects-property)
     * @param domainUrl - String, eg: https://www.bridgecrew.cloud
     * @param baseSvgUrl - String, the S3 bucket url or the cloudFront url eg: https://www.bridgecrew.cloud or https://bridgecrew-badges-123456789-TAG.s3-us-west-2.amazonaws.com
     * @param repoOwner - String, the repository owner, eg: bridgecrew
     * @param repoName - Strong, the repository name, eg: terragoat
     * @returns [{svgUrl, title, markdownUrl}]
     * @private
     */
    _createBadgesResponseFromS3Contents({ s3Contents, domainUrl, baseSvgUrl, fullRepo, vcs }) {
        let badges = [];
        try {
            for (const s3Content of s3Contents) {
                const badgeId = s3Content.Key.split('/').pop();
                if (!BADGE_ID_MAP[badgeId]) continue;
                const linkToBC = new URL(`${domainUrl}/link/badge`);
                linkToBC.searchParams.append('vcs', vcs);
                linkToBC.searchParams.append('fullRepo', fullRepo);
                linkToBC.searchParams.append('benchmark', BADGE_ID_MAP[badgeId].title.toUpperCase());
                const svgUrl = `${baseSvgUrl}/${s3Content.Key}`;
                const svg = {
                    svgUrl,
                    title: BADGE_ID_MAP[badgeId].title,
                    markdownUrl: `[![Infrastructure Tests](${svgUrl})](${linkToBC.href})`,
                    order: BADGE_ID_MAP[badgeId].order
                };
                badges.push(svg);
            }
            badges = badges.sort((a, b) => a.order - b.order);
            return badges.map(({ order, ...badge }) => badge);
        } catch (e) {
            console.error('got error on _createBadgesResponseFromS3Contents: ', e);
            throw e;
        }
    }

    async create(params) {
        console.info(`creating badge for customer: ${params.customerName}, ownerName: ${params.ownerName}, vcs: ${params.vcs}, repositoryName: ${params.repositoryName}, isPublic: ${params.isPublic}`);

        const bodyValidationError = badgesBodySchema.validate(params).error;

        if (bodyValidationError) {
            console.error('body does not contain all the needed attributes', JSON.stringify(params), bodyValidationError);
            throw new Error('body does not contain all the needed attributes', JSON.stringify(params), bodyValidationError);
        }

        const { customerName, ownerName, vcs, repositoryName, isPublic } = params;

        if (!isPublic) {
            console.log('we currently not creating badges for private repositories.');
            // todo: if private - upload to s3 with TOKEN (path param) - PHASE 2
            return;
        }

        const badgesData = await this.getBadgesData({ customerName, repositoryName: `${ownerName}/${repositoryName}` });
        console.log('This is the badges data: ', badgesData);

        const badges = this._createBadges(badgesData);

        await this._uploadToS3({ badges, vcs, repositoryName, ownerName });
    }

    async getBadgesData({ customerName, repositoryName }) {
        try {
            const errorsByBenchmark = await this.violationsService.getErrorsByBenchmarks({ customerName, sourceIds: [repositoryName] });
            const errorsByCustomerAndRepo = await this.violationsService.getErrorsByCustomerNameAndSourceId({ customerName, sourceIds: [repositoryName] });

            console.log('These are the errors by benchmark: ', JSON.stringify(errorsByBenchmark));
            console.log('These are errors by customer and repo: ', JSON.stringify(errorsByCustomerAndRepo));

            const badgesToGenerate = [];

            // Relevant for benchmark badges
            errorsByBenchmark.forEach(element => badgesToGenerate.push({ badgeName: element.benchmark_id, value: !element.amount }));

            if (errorsByCustomerAndRepo.length === 0) {
                badgesToGenerate.push({ badgeName: GENERAL_BADGES.INFRASTRUCTURE_SECURITY, value: config.allPassing });
            } else {
                badgesToGenerate.push({ badgeName: GENERAL_BADGES.INFRASTRUCTURE_SECURITY, value: `${errorsByCustomerAndRepo[0].count} errors` });
            }

            return badgesToGenerate;
        } catch (e) {
            console.error(`[ERROR] - Failed to get badges data for ${customerName} and repository ${repositoryName}. Error: `, e);
            throw new Error(`[ERROR] - Failed to get badges data for ${customerName} and repository ${repositoryName}`);
        }
    }

    _createBadges(badgesData) {
        const badges = [];
        badgesData.forEach(badgeData => {
            console.info(`calculating badge for: ${badgeData.badgeName}`);
            const badgeId = MAP_BADGE_TITLE_TO_ID[badgeData.badgeName];
            if (!badgeId) return; // protection for case benchmarks exist on D.B but not define on BADGE_ID_MAP (generator.js)
            const badge = FactoryBadge.createBadge(badgeId, badgeData.value);
            badges.push({ id: badgeId, string: badge.getSvgString() });
            console.info(`successfully created badge for: ${badgeData.badgeName}`);
        });

        return badges;
    }

    async _uploadToS3({ badges, vcs, repositoryName, ownerName, branchName }) {
        let path = `badges/${vcs}/${ownerName}/${repositoryName}`;
        if (branchName) path += `/${branchName}`;
        path = path.toLowerCase();
        console.info(`uploading ${badges.length} badges to S3 bucket: ${BADGES_S3_BUCKET_NAME} on the following path: ${path}`);
        const results = await Promise.all(badges.map(async badge => {
            const fullPath = `${path}/${badge.id}`;
            try {
                return await S3.putObject({
                    Bucket: BADGES_S3_BUCKET_NAME,
                    Key: fullPath,
                    Body: badge.string,
                    ContentType: 'image/svg+xml',
                    CacheControl: 'no-cache, no-store, must-revalidate',
                    Expires: new Date() // important: this is how github 'knows' to update the badge if change
                }).promise();
            } catch (e) {
                console.log(`Failed to save badge: ${badge.id} to S3 bucket: ${BADGES_S3_BUCKET_NAME} with path: ${fullPath} error: ${e}`);
                throw e;
            }
        }));
        console.info('latest ETags:', results.map(r => r.ETag).join(','));
        console.info(`successfully upload ${results.length} badges`);
    }

    /**
     * Deleted all the badges for bulk of repositories
     * @param deleteData - {vcs, repositories} :
     * @param repoOwner.vcs - String, the vcs type, eg: Github
     * @param repoOwner.repositories - Array of Objects, eg: [{ owner: 'owner1', name: 'repo_name_1'}, { owner: 'owner_2', name: 'repo_name_2'}, { fullRepoPath: 'owner_3/repo_owner_3'} ...]
     * @returns {Promise<Array of the keys that deleted from S3 bucket|*>}
     */
    async delete(deleteData) {
        const bodyValidationError = deleteBadgesBodySchema.validate(deleteData).error;

        if (bodyValidationError) {
            console.error('body does not contain all the needed attributes', JSON.stringify(deleteData), bodyValidationError);
            throw new Error(`body does not contain all the needed attributes: ${bodyValidationError}\n${JSON.stringify(deleteData)}`);
        }

        const { vcs, repositories } = deleteData;

        console.info(`deleting ${vcs} badges, repositories:\n ${JSON.stringify(repositories)}`);

        let objectKeysToDelete = [];

        await Promise.all(repositories.map(async repoObject => {
            if (!repoObject.fullRepoPath && !(repoObject.owner && repoObject.name)) {
                throw new Error(`bad params for: ${JSON.stringify(repoObject)} - repositories elements: object must be {fullRepoPath} or {owner,name} !`);
            }
            const fullRepo = repoObject.fullRepoPath || `${repoObject.owner}/${repoObject.name}`;
            const params = {
                Bucket: BADGES_S3_BUCKET_NAME,
                Prefix: `badges/${vcs}/${fullRepo}`.toLowerCase()
            };
            const listObjects = await S3.listObjects(params).promise();
            objectKeysToDelete = objectKeysToDelete.concat(listObjects.Contents.map(content => content.Key));
        }));

        console.info(`${objectKeysToDelete.length} badges are about to deletes from: ${BADGES_S3_BUCKET_NAME} - keys:`, objectKeysToDelete);

        if (objectKeysToDelete.length === 0) {
            console.info('no badges exist.');
            return [];
        }

        const deletedBadgeKeys = [];
        while (objectKeysToDelete.length) {
            const deleteResponse = await S3.deleteObjects({
                Bucket: BADGES_S3_BUCKET_NAME,
                Delete: {
                    Objects: objectKeysToDelete.splice(0, MAX_FILES_TO_DELETE_CHUNK).map(objectKey => ({ Key: objectKey }))
                }

            }).promise();
            deletedBadgeKeys.push(...deleteResponse.Deleted);
        }
        console.info(`successfully deleted ${deletedBadgeKeys.length} keys.`);
        return deletedBadgeKeys;
    }
}

const getInstance = () => new BadgesService();

module.exports = { BadgesService, GENERAL_BADGES, getInstance };