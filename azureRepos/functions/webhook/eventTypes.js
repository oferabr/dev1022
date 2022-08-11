const { handleYorClosedMergedPR, getCustomerName } = require('@bridgecrew/nodeUtils/vcs/utils');
const { getVCSRepoConfIfFeatureEnabled } = require('@bridgecrew/nodeUtils/vcs/repoSettingSchema');
const { MODULE_TYPE } = require('@bridgecrew/nodeUtils/models/Enums');
const RemoteLambda = require('@bridgecrew/nodeUtils/remoteLambda/invoke');
const epsagon = require('epsagon');
const { MissingIntegrationError } = require('@bridgecrew/vcs-classes');
const { isEnforcementRuleFeatureFlagEnabled } = require('../../../utils/index');
const { AzureReposServiceMgr } = require('../mgr/azureReposServiceMgr');
const { webhook: webhookConf } = require('../conf/config');

const settingsMgrApiLambda = new RemoteLambda(process.env.SETTINGS_MGR_API_LAMBDA);

const extractPullRequestParams = (body) => {
    const { id: repoId, webUrl, url, name: repoName, project: { name: projectName, id: projectId } } = body.resource.repository;
    const { sourceRefName, targetRefName, pullRequestId, lastMergeSourceCommit, title: prTitle, status, createdBy: { displayName: author } } = body.resource;
    const org = new URL(webUrl || url).pathname.split('/').filter(f => f)[0]; // the org not returned on the payload, so this is the best way to fetch it.

    return {
        org,
        projectName,
        projectId,
        repoName,
        repoId,
        fromBranch: sourceRefName.split('refs/heads/').filter(f => f)[0], // it's the best way to get the branch name
        intoBranch: targetRefName.split('refs/heads/').filter(f => f)[0], // it's the best way to get the branch name
        pr: pullRequestId,
        commit: lastMergeSourceCommit.commitId,
        prTitle,
        status,
        author
    };
};

const handlePRChanged = async (body, isNewCommitToPR) => {
    const { org, projectName, projectId, repoName, repoId, fromBranch, intoBranch, pr, commit, prTitle, status, author } = extractPullRequestParams(body);

    const repositoryFullName = `${org}/${projectName}/${repoName}`;
    const customerName = await getCustomerName(repositoryFullName);
    if (!customerName) {
        console.info(`repository: ${repositoryFullName} does not exist/not selected`);
        return;
    }
    epsagon.label('customerName', customerName);
    console.info(`customer name: ${customerName} repository full name: ${repositoryFullName}`);
    const azureReposServiceMgr = new AzureReposServiceMgr();
    try {
        await azureReposServiceMgr.init({ customerName });
        const repo = await azureReposServiceMgr.getRepository({ customerName, project: `${org}/${projectName}`, repositoryName: repoId });
        if (status === 'abandoned') {
            console.info(`pr: ${pr} of repository: ${repositoryFullName} abandoned`);
            await handleYorClosedMergedPR({
                owner: `${org}/${projectName}`,
                name: repoName,
                prNumber: pr,
                repositoriesApiLambda: process.env.REPOSITORIES_API_LAMBDA,
                yorPRLambdaName: process.env.YOR_PR_LAMBDA,
                isMerged: false });
            await azureReposServiceMgr.updatePREntities({ isMerged: false,
                fromBranch,
                pullNumber: pr,
                owner: `${org}/${projectName}`,
                repository: repoName,
                customerName });
            return;
        }

        if (status === 'completed') {
            console.info(`pr: ${pr} of repository: ${repositoryFullName} completed`);

            await handleYorClosedMergedPR({
                owner: `${org}/${projectName}`,
                name: repoName,
                prNumber: pr,
                repositoriesApiLambda: process.env.REPOSITORIES_API_LAMBDA,
                yorPRLambdaName: process.env.YOR_PR_LAMBDA,
                isMerged: false
            });

            return await azureReposServiceMgr.handlePullRequestCompleted({
                customerName,
                owner: `${org}/${projectName}`,
                repository: repoName,
                pullNumber: pr,
                isMerged: repo.defaultBranch === intoBranch,
                fromBranch
            });
        }
        const { domain, isPrisma } = await settingsMgrApiLambda.invoke('vcsSettings/getCustomerPlatformBaseURL', { customerName });
        const enforcementRulesEnabled = await isEnforcementRuleFeatureFlagEnabled(process.env.FEATURE_FLAGS_LAMBDA, customerName, isPrisma ? MODULE_TYPE.PC : MODULE_TYPE.BC);
        const repoSettingSchema = await settingsMgrApiLambda.invoke('vcsSettings/getScheme', { customerName, fullRepoName: repositoryFullName });
        const codeReviewsEnabled = await getVCSRepoConfIfFeatureEnabled({ repoSettingSchema, customerName, featureName: 'codeReviews', fullRepoName: repositoryFullName });
        console.log('codeReviewsEnabled', JSON.stringify({ codeReviewsEnabled, enforcementRulesEnabled }));
        if (codeReviewsEnabled || enforcementRulesEnabled) {
            return await azureReposServiceMgr.handlePullRequest({
                eventType: webhookConf.eventTypes.PR_CREATED,
                repoSettingSchema,
                repositoryFullName,
                org,
                project: projectName,
                projectId,
                name: repoName,
                repoId,
                fromBranch,
                intoBranch,
                pr,
                commit,
                prTitle,
                author,
                isNewCommitToPR,
                domain,
                isPrisma,
                enforcementRulesEnabled
            });
        }
        console.log(`customer name: ${customerName} repository full name: ${repositoryFullName} will not start a code review as it is disabled`);
    } catch (e) {
        if (e instanceof MissingIntegrationError) {
            console.warn(` failed to handlePRChanged - couldn't find this webhook's repository, ${e.message}`);
        } else {
            throw new Error(`failed to handlePRChanged, customer name: ${customerName} repository full name: ${repositoryFullName}`);
        }
    }
};

const eventTypes = {
    [webhookConf.eventTypes.PR_CREATED]: async (body) => {
        console.info(`got pull request created event.\n${JSON.stringify(body)}`);
        return await handlePRChanged(body);
    },
    [webhookConf.eventTypes.PR_UPDATED]: async (body) => {
        console.info(`got pull request updated event.\n${JSON.stringify(body)}`);
        return await handlePRChanged(body, true);
    }
};

module.exports = eventTypes;