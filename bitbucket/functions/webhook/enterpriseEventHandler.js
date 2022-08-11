const RemoteLambda = require('@bridgecrew/nodeUtils/remoteLambda/invoke');
const { MODULE_TYPE } = require('@bridgecrew/nodeUtils/models/Enums');
const { getCustomerName, getViolationConfigurations } = require('@bridgecrew/nodeUtils/vcs/utils');
const epsagon = require('epsagon');
const { BitbucketEnterpriseServiceMgr } = require('../mgr/bitbucketEnterpriseServiceMgr');
const { isEnforcementRuleFeatureFlagEnabled } = require('../../../utils');

const settingsMgrApiLambda = new RemoteLambda(process.env.SETTINGS_MGR_API_LAMBDA);
const customersRemoteLambda = new RemoteLambda(process.env.CUSTOMERS_API_LAMBDA);

const VCS_WEBHOOK_SF_NAME = 'VcsWebhookScanner';
const SCANNER_TYPE = 'checkov';

async function handlePrWebhooks({ repositoryFullName, workspace, repositoryName, pullRequestId, latestCommitHash, fromBranch, intoBranch, prTitle, author, eventType }) {
    const customerName = await getCustomerName(repositoryFullName);
    if (!customerName) {
        const res = `repository: ${repositoryFullName} does not exist/not selected`;
        console.info(res);
        return { code: 404, data: res };
    }
    epsagon.label('customerName', customerName);
    const isCustomerValid = await customersRemoteLambda.invoke('customers/controller/isCustomerValid', {
        customerName,
        scannerName: VCS_WEBHOOK_SF_NAME
    }, undefined, { newInvoke: true });
    if (!isCustomerValid) {
        console.log(`customer: ${customerName} is not valid for pull requests webhooks`);
        return;
    }

    const { domain, isPrisma } = await settingsMgrApiLambda.invoke('vcsSettings/getCustomerPlatformBaseURL', { customerName });
    const enforcementRulesEnabled = await isEnforcementRuleFeatureFlagEnabled(process.env.FEATURE_FLAGS_LAMBDA, customerName, isPrisma ? MODULE_TYPE.PC : MODULE_TYPE.BC);
    const repoSettingSchema = await settingsMgrApiLambda.invoke('vcsSettings/getScheme', {
        customerName,
        fullRepoName: repositoryFullName
    });

    const violationConfigurationsMap = await getViolationConfigurations({ violationApiLambdaName: process.env.VIOLATIONS_API_LAMBDA_NAME, customerName });

    const bitbucketEnterpriseServiceMgr = new BitbucketEnterpriseServiceMgr();
    await bitbucketEnterpriseServiceMgr.init({ customerName });
    await bitbucketEnterpriseServiceMgr.handlePullRequest({
        eventType,
        customerName,
        repoSettingSchema,
        workspace,
        repositoryName,
        pullRequestId,
        nodeHash: latestCommitHash,
        fromBranch,
        intoBranch,
        prTitle,
        author,
        violationConfigurationsMap,
        scannerType: SCANNER_TYPE,
        domain,
        isPrisma,
        enforcementRulesEnabled
    });
}

const EVENTS = {
    'repo:refs_changed': async (payload) => {
        /**
         * This event get called when some ref have changed (for example for push events)
         * For check what changes, use the payload.changes field
         */
        const workspace = payload.repository.project.key;
        const repositoryName = payload.repository.slug;
        const repositoryFullName = `${payload.repository.project.key}/${payload.repository.slug}`;
        console.info(`got repo:refs_changed event of repo: ${repositoryFullName}`);
        const customerName = await getCustomerName(repositoryFullName);
        if (!customerName) {
            const res = `repository: ${repositoryFullName} does not exist/not selected`;
            console.info(res);
            return { code: 404, data: res };
        }
        epsagon.label('customerName', customerName);
        const relevantChange = payload.changes ? payload.changes.filter(change => change.ref && change.ref.type === 'BRANCH' && change.type === 'UPDATE') : [];
        let fromBranch;
        if (relevantChange.length) {
            fromBranch = relevantChange[0].ref.displayId;
        } else {
            console.log('Got irrelevant change webhook');
            return;
        }
        await handlePrWebhooks({ repositoryFullName, workspace, repositoryName, fromBranch, eventType: 'repo:refs_changed' });
    },
    'pr:opened': async (payload) => {
        const { pullRequest } = payload;
        console.info(`got pr:opened event, PR id: ${pullRequest.id} from ref: ${pullRequest.fromRef.id} to ref: ${pullRequest.toRef.id}`);
        const workspace = pullRequest.fromRef.repository.project.key;
        const repositoryName = pullRequest.fromRef.repository.slug;
        const repositoryFullName = `${pullRequest.fromRef.repository.project.key}/${pullRequest.fromRef.repository.slug}`;
        const customerName = await getCustomerName(repositoryFullName);
        if (!customerName) {
            const res = `repository: ${repositoryFullName} does not exist/not selected`;
            console.info(res);
            return { code: 404, data: res };
        }
        epsagon.label('customerName', customerName);
        const latestCommitHash = pullRequest.fromRef.latestCommit;
        const pullRequestId = pullRequest.id;
        const fromBranch = pullRequest.fromRef.displayId;
        const intoBranch = pullRequest.toRef.displayId;
        const author = pullRequest.author.user.slug;
        const prTitle = pullRequest.title;
        await handlePrWebhooks({ repositoryFullName, workspace, repositoryName, pullRequestId, latestCommitHash, fromBranch, intoBranch, prTitle, author, eventType: 'pr:opened' });
    },
    'pr:merged': async (payload) => {
        const { pullRequest } = payload;
        console.info(`got pr:merged event, PR id: ${pullRequest.id} from ref: ${pullRequest.fromRef.id} to ref: ${pullRequest.toRef.id}`);
        const workspace = pullRequest.fromRef.repository.project.key;
        const repositoryName = pullRequest.fromRef.repository.slug;
        const repositoryFullName = `${pullRequest.fromRef.repository.project.key}/${pullRequest.fromRef.repository.slug}`;
        const pullRequestId = pullRequest.id;
        const fromBranch = pullRequest.fromRef.displayId;
        const intoBranch = pullRequest.toRef.displayId;

        const customerName = await getCustomerName(repositoryFullName);
        if (!customerName) {
            const res = `repository: ${repositoryFullName} does not exist/not selected`;
            console.info(res);
            return { code: 404, data: res };
        }
        epsagon.label('customerName', customerName);
        const bitbucketEnterpriseServiceMgr = new BitbucketEnterpriseServiceMgr();
        await bitbucketEnterpriseServiceMgr.init({ customerName });
        await bitbucketEnterpriseServiceMgr.handleMergedPR({
            customerName,
            workspace,
            repo: repositoryName,
            pullNumber: pullRequestId,
            intoBranchName: intoBranch,
            defaultBranchName: fromBranch,
            isMerged: true
        });
    },
    'pr:declined': async (payload) => {
        const { pullRequest } = payload;
        console.info(`got pr:merged event, PR id: ${pullRequest.id} from ref: ${pullRequest.fromRef.id} to ref: ${pullRequest.toRef.id}`);
        const workspace = pullRequest.fromRef.repository.project.key;
        const repositoryName = pullRequest.fromRef.repository.slug;
        const repositoryFullName = `${pullRequest.fromRef.repository.project.key}/${pullRequest.fromRef.repository.slug}`;
        const pullRequestId = pullRequest.id;
        const fromBranch = pullRequest.fromRef.displayId;
        const intoBranch = pullRequest.toRef.displayId;

        const customerName = await getCustomerName(repositoryFullName);
        if (!customerName) {
            const res = `repository: ${repositoryFullName} does not exist/not selected`;
            console.info(res);
            return { code: 404, data: res };
        }
        epsagon.label('customerName', customerName);
        const bitbucketEnterpriseServiceMgr = new BitbucketEnterpriseServiceMgr();
        await bitbucketEnterpriseServiceMgr.init({ customerName });
        await bitbucketEnterpriseServiceMgr.handleMergedPR({
            customerName,
            workspace,
            repo: repositoryName,
            pullNumber: pullRequestId,
            intoBranchName: intoBranch,
            defaultBranchName: fromBranch,
            isMerged: false,
            fromBranch
        });
    }
};

module.exports = EVENTS;