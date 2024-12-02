const Joi = require('joi');
const { SOURCE_TYPES, VCS_TRIGGER_TYPES } = require('@bridgecrew/nodeUtils/models/Enums');
const { GitServiceMgr } = require('./mgr/gitServiceMgr');
const { YorPullRequestMgr } = require('./mgr/pullRequestMgr');
const { CkvGitServiceMgr } = require('./mgr/ckvGitServiceMgr');

const repoSchema = Joi.object({
    owner: Joi.string().required(),
    name: Joi.string().required(),
    branch: Joi.string(),
    fullForkedRepoName: Joi.string()
});

const GitServiceMgrSchema = Joi.object({
    customerName: Joi.string().required(),
    sourceType: Joi.string().required(),
    repositories: Joi.array().items(repoSchema),
    prefix: Joi.string()
});

const repoToCloneSchema = Joi.object({
    id: Joi.string().required(),
    owner: Joi.string().required(),
    repository: Joi.string().required(),
    source: Joi.string().required(),
    defaultBranch: Joi.string().allow(null).optional(),
    creationDate: Joi.date()
});

const getCloneErrorsSchema = Joi.object({
    customerName: Joi.string().required(),
    executionTime: Joi.string().required()
});

const cloneSuccessLogSchema = Joi.object({
    repositoryName: Joi.string().required(),
    repositoryId: Joi.string().required(),
    cloneSize: Joi.number().required(),
    cloneDuration: Joi.number().required()
});

const cloneFailureLogSchema = Joi.object({
    repositoryName: Joi.string().required(),
    repositoryId: Joi.string().required(),
    failureTime: Joi.number().required(),
    error: Joi.string().required()
});

const writeCloneResultsSchema = Joi.object({
    customerName: Joi.string().required(),
    executionTime: Joi.string().required(),
    cloneResults: Joi.array().items(Joi.alternatives()
        .try(cloneFailureLogSchema, cloneSuccessLogSchema))
});

const GitServiceMgrCloneSchema = Joi.object({
    customerName: Joi.string().required(),
    executionTime: Joi.date().required(),
    repository: repoToCloneSchema,
    prefix: Joi.string(),
    fullClone: Joi.boolean(),
    shouldConsiderBlackList: Joi.boolean(),
    branch: Joi.string()
});

const OpenYorPRSchema = Joi.object({
    customerName: Joi.string().required(),
    repoOwner: Joi.string().required(),
    repoName: Joi.string().required(),
    sourceType: Joi.string().required(),
    s3PathObject: Joi.object({
        prefix: Joi.string().required(),
        relativePaths: Joi.array().items(Joi.string().required())
    }),
    fromBranch: Joi.string().required()
});

const SUPPORTED_VCS = [SOURCE_TYPES.GITHUB, SOURCE_TYPES.GITLAB, SOURCE_TYPES.BITBUCKET];

const fetchGitBlame = async ({ customerName, sourceType, repositories, triggerType }) => {
    console.info(`git controller called - fetchGitBlame: ${customerName} ${sourceType} ${triggerType} ${JSON.stringify(repositories)}`);

    const validationError = GitServiceMgrSchema.validate({ customerName, sourceType, repositories }).error;

    if (validationError) {
        const msg = `fetchGitBlame params does not contain all the needed attributes: ${validationError}`;
        console.error(msg);
        throw new Error(msg);
    }

    if (triggerType !== VCS_TRIGGER_TYPES.PERIODIC) {
        console.info(`trigger type: ${triggerType} doesn't supported for git blame`);
        return `NOT TRIGGER TYPE FOR: ${triggerType}`;
    }

    if (!SUPPORTED_VCS.includes(sourceType)) {
        console.info(`source type: ${sourceType} doesn't supported for git blame`);
        return `NOT SUPPORTED FOR: ${sourceType}`;
    }

    const gitServiceMgr = new GitServiceMgr();
    try {
        const response = await gitServiceMgr.fetchGitBlame({ customerName, sourceType, repositories });
        return response;
    } catch (e) {
        console.error(`git controller got error for customer: ${customerName} error: ${e}`);
        throw e;
    }
};

const cloneRepoAndUploadToS3 = async ({ customerName, sourceType, repositories, prefix, commit }) => {
    console.info(`git controller called - cloneRepoAndUploadToS3: ${customerName} ${sourceType} ${JSON.stringify(repositories)}`);
    const validationError = GitServiceMgrSchema.validate({ customerName, sourceType, repositories }).error;

    if (validationError) {
        const msg = `cloneRepoAndUploadToS3 params does not contain all the needed attributes: ${validationError}`;
        console.error(msg);
        throw new Error(msg);
    }

    const gitServiceMgr = new GitServiceMgr();
    try {
        const response = await gitServiceMgr.cloneRepoAndUploadToS3({ customerName, sourceType, repositories, prefix, commitHash: commit });
        return response;
    } catch (e) {
        console.error(`git controller got error for customer: ${customerName} error: ${e}`);
        throw e;
    }
};

const cloneRepository = async ({ customerName, repository, executionTime, fullClone = true, shouldConsiderBlackList = false, branch }) => {
    console.info(`[gitController][cloneRepository] - git controller called for: ${customerName} ${repository.source} ${JSON.stringify(repository)}`);
    const validationError = GitServiceMgrCloneSchema.validate({ customerName, repository, executionTime, fullClone, shouldConsiderBlackList, branch }).error;

    if (validationError) {
        const msg = `[gitController][cloneRepository] - event body params does not contain all the needed attributes: ${validationError}`;
        console.error(msg);
        throw new Error(msg);
    }

    const gitServiceMgr = new GitServiceMgr();
    try {
        const response = await gitServiceMgr.cloneRepository({ customerName, repository, executionTime, fullClone, shouldConsiderBlackList, branch });
        return response;
    } catch (e) {
        console.error(`[gitController][cloneRepository] - got error for customer: ${customerName}, repository: ${repository} error: ${e}`);
        throw e;
    }
};

const getCloneErrorsForScan = async ({ customerName, executionTime, source }) => {
    console.info(`[gitController][getCloneErrorsForScan] - git controller called for: ${customerName} for execution ${executionTime}`);
    const validationError = getCloneErrorsSchema.validate({ customerName, executionTime }).error;

    if (validationError) {
        const msg = `[gitController][getCloneErrorsForScan] - event body params does not contain all the needed attributes: ${validationError}`;
        console.error(msg);
        throw new Error(msg);
    }

    const gitServiceMgr = new GitServiceMgr();
    try {
        const response = await gitServiceMgr.getCloneErrorsForScan({ customerName, executionTime, source });
        return response;
    } catch (e) {
        console.error(`[gitController][getCloneErrorsForScan] - got error for customer: ${customerName}, executionTime: ${executionTime} error: ${e}`);
        throw e;
    }
};

const writeCloneResults = async ({ customerName, executionTime, source, cloneResults }) => {
    console.info(`[gitController][writeCloneResults] - git controller called for: ${customerName} for execution ${executionTime}`);
    const validationError = writeCloneResultsSchema.validate({ customerName, executionTime, cloneResults }).error;

    if (validationError) {
        const msg = `[gitController][writeCloneResults] - event body params does not contain all the needed attributes: ${validationError}`;
        console.error(msg);
        throw new Error(msg);
    }

    const gitServiceMgr = new GitServiceMgr();
    try {
        const response = await gitServiceMgr.writeCloneResults({ customerName, executionTime, source, cloneResults });
        return response;
    } catch (e) {
        console.error(`[gitController][writeCloneResults] - got error for customer: ${customerName}, executionTime: ${executionTime} error: ${e}`);
        throw e;
    }
};

const getRelevantResources = async ({ customerName, resources, sourceType, repository, patchLinesToFileMapping }) => {
    console.info(`git controller called - getRelevantResources: ${customerName} ${JSON.stringify(resources)} ${repository} ${patchLinesToFileMapping}`);
    const validationError = GitServiceMgrSchema.validate({ customerName, sourceType }).error;

    if (validationError) {
        const msg = `getRelevantResources params does not contain all the needed attributes: ${validationError}`;
        console.error(msg);
        throw new Error(msg);
    }

    const gitServiceMgr = new GitServiceMgr();
    try {
        const response = await gitServiceMgr.getRelevantResources({ customerName, resources, sourceType, repository, patchLinesToFileMapping });
        return response;
    } catch (e) {
        console.error(`git controller got error for customer: ${customerName} error: ${e}`);
        throw e;
    }
};

const openYorPR = async ({ customerName, repoOwner, repoName, sourceType, s3PathObject, fromBranch }) => {
    const validationError = OpenYorPRSchema.validate({ customerName, repoOwner, repoName, sourceType, s3PathObject, fromBranch }).error;

    if (validationError) {
        const msg = `openYorPR params does not contain all the needed attributes: ${validationError}`;
        console.error(msg);
        throw new Error(msg);
    }

    const pullRequestMgr = new YorPullRequestMgr({ customerName, repoOwner, repoName, sourceType, s3PathObject, fromBranch });
    try {
        const response = await pullRequestMgr.makePullRequest();
        return response;
    } catch (e) {
        console.error(`[openYorPR] got error for customer: ${customerName} error: ${e}`);
        throw e;
    }
};

const saveCheckovIncidentsCode = async () => {
    try {
        const ckvGitServiceMgr = new CkvGitServiceMgr();
        await ckvGitServiceMgr.saveCkvFilesCode();
    } catch (e) {
        console.error(`[saveCheckovIncidentsCode] got error: ${e}`);
        throw e;
    }
};

module.exports = {
    fetchGitBlame,
    cloneRepoAndUploadToS3,
    getRelevantResources,
    openYorPR,
    saveCheckovIncidentsCode,
    cloneRepository,
    getCloneErrorsForScan,
    writeCloneResults
};