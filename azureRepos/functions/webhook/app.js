const { getBCExpressRouter, bcHandler } = require('@bridgecrew/api');
const { handleAzureReposWebhook } = require('./controller');

const app = getBCExpressRouter();

/**
 * public end-point to handle the gitlab web hook post events
 */
app.post('/api/v1/azureRepos/webhook', handleAzureReposWebhook);

module.exports.handler = bcHandler(app);