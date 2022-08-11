const serverless = require('serverless-http');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { HttpError, InternalServerError, addAuthorizerContextToRequest } = require('@bridgecrew/api');
const RemoteLambda = require('@bridgecrew/nodeUtils/remoteLambda/invoke');
const { MODULE_TYPE } = require('@bridgecrew/nodeUtils/models/Enums');

const { getViolationConfigurations, getCustomerName } = require('@bridgecrew/nodeUtils/vcs/utils');

const VCS_WEBHOOK_SF_NAME = 'VcsWebhookScanner';
const settingsMgrApiLambda = new RemoteLambda(process.env.SETTINGS_MGR_API_LAMBDA);
const epsagon = require('epsagon');
const { BitbucketServiceMgr } = require('../mgr/bitbucketServiceMgr');
const EVENTS = require('./enterpriseEventHandler');
const { isEnforcementRuleFeatureFlagEnabled } = require('../../../utils');

const app = express();

const SCANNER_TYPE = 'checkov';
const config = require('../mgr/conf/config').serviceManager;

const customersRemoteLambda = new RemoteLambda(process.env.CUSTOMERS_API_LAMBDA);

app.use(cors());
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use(bodyParser.json({ limit: '50mb' }));
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    if (req.method === 'OPTIONS') {
        res.send(200);
    } else {
        next();
    }
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    if (!(err instanceof HttpError)) {
        // eslint-disable-next-line no-param-reassign
        err = new InternalServerError(err.message);
    }
    console.error(err.message, err.stack);
    res.status(err.statusCode).json({
        message: err.message
    });
});

/**
 * public end-point to handle the bitbucket web hook post events
 * list of events types: https://confluence.atlassian.com/bitbucket/manage-webhooks-735643732.html
 */
app.post('/api/v1/bitbucket/webhook', async (req, res) => {
    try {
        // todo: encrypt the payload ot at least validate that the source ip is Bitbucket Cloud IP addresses (https://confluence.atlassian.com/bitbucket/what-are-the-bitbucket-cloud-ip-addresses-i-should-use-to-configure-my-corporate-firewall-343343385.html#)
        console.info('got bitbucket webhook request: ', req);
        const { headers } = req;
        const eventType = headers['x-event-key'];
        const eventId = headers['x-hook-uuid'];
        console.info(`got web hook event id: ${eventId}, type: ${eventType}`);
        const { body } = req;

        console.info(`payload headers:\n${JSON.stringify(headers)}`);
        console.info(`payload body:\n${JSON.stringify(body)}`);

        const repositoryFullName = body.repository.full_name;
        const pullRequestId = body.pullrequest.id;
        const nodeHash = body.pullrequest.source.commit.hash;

        const customerName = await getCustomerName(repositoryFullName);
        if (!customerName) {
            const data = `repository: ${repositoryFullName} does not exist/not selected`;
            console.info(data);
            return res.status(404).json({ data });
        }
        epsagon.label('customerName', customerName);
        const [workspace, repositoryName] = repositoryFullName.split('/');

        const isCustomerValid = await customersRemoteLambda.invoke('customers/controller/isCustomerValid', { customerName, scannerName: VCS_WEBHOOK_SF_NAME }, undefined, { newInvoke: true });
        if (!isCustomerValid) {
            console.log(`customer: ${customerName} is not valid for pull requests webhooks`);
            return res.status(200).send();
        }

        const fromBranch = body.pullrequest.source.branch.name;

        const { domain, isPrisma } = await settingsMgrApiLambda.invoke('vcsSettings/getCustomerPlatformBaseURL', { customerName });
        const enforcementRulesEnabled = await isEnforcementRuleFeatureFlagEnabled(process.env.FEATURE_FLAGS_LAMBDA, customerName, isPrisma ? MODULE_TYPE.PC : MODULE_TYPE.BC);

        const repoSettingSchema = await settingsMgrApiLambda.invoke('vcsSettings/getScheme', { customerName, fullRepoName: `${workspace}/${repositoryName}` });

        const violationConfigurationsMap = await getViolationConfigurations({ violationApiLambdaName: process.env.VIOLATIONS_API_LAMBDA_NAME, customerName });

        const bitbucketServiceMgr = new BitbucketServiceMgr();
        await bitbucketServiceMgr.init({ customerName });

        const intoBranch = body.pullrequest.destination.branch.name;
        const author = body.pullrequest.author.display_name;
        const prTitle = body.pullrequest.rendered.title.raw;

        await bitbucketServiceMgr.handlePullRequest({
            eventType,
            customerName,
            repoSettingSchema,
            workspace,
            repositoryName,
            pullRequestId,
            prTitle,
            nodeHash,
            violationConfigurationsMap,
            scannerType: SCANNER_TYPE,
            fromBranch,
            intoBranch,
            author,
            domain,
            isPrisma,
            enforcementRulesEnabled
        });

        return res.json({ success: true });
    } catch (err) {
        console.error('failed to handle bitbucket webhook due to following error:', err);
        throw err;
    }
});

/**
 * public end-point to handle the bitbucket server web hook post events
 * list of events types (Repository): https://confluence.atlassian.com/bitbucketserver067/event-payload-979426861.html?utm_campaign=in-app-help&utm_medium=in-app-help&utm_source=stash#Eventpayload-repositoryevents
 * list of events types (Pull Request): https://confluence.atlassian.com/bitbucketserver067/event-payload-979426861.html?utm_campaign=in-app-help&utm_medium=in-app-help&utm_source=stash#Eventpayload-pullrequest
 * API: https://docs.atlassian.com/bitbucket-server/rest/5.16.0/bitbucket-rest.html
 */
app.post('/api/v1/bitbucketEnterprise/webhook', async (req, res) => {
    try {
        // todo: encrypt the payload or verify the source ip
        console.info('got bitbucket enterprise webhook request: ', req);
        const { headers } = req;
        const eventType = headers['x-event-key'];
        const eventId = headers['x-request-id'];
        console.info(`got web hook event id: ${eventId}, type: ${eventType}`);
        const { body } = req;

        console.info(`payload headers:\n${JSON.stringify(headers)}`);
        console.info(`payload body:\n${JSON.stringify(body)}`);

        if (EVENTS[eventType]) {
            const response = await EVENTS[eventType](body);
            if (response && response.code === 404) {
                return res.status(404).json({ data: response.data });
            }
        }

        return res.json({ success: true });
    } catch (err) {
        console.error('failed to handle bitbucket enterprise webhook due to following error:', err);
        throw err;
    }
});

exports.handler = (event, context) => serverless(app, {
    request(req, e, ctx) {
        req.event = e;
        req.context = ctx;
        addAuthorizerContextToRequest(req);
    },
    binary: false
})(event, context);