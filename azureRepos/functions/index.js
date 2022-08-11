const { Invoker, getBCExpressRouter, bcHandler } = require('@bridgecrew/api');
const azureReposController = require('./controller');
const { AzureReposServiceMgr } = require('./mgr/azureReposServiceMgr');

const handler = getBCExpressRouter();
handler.get('/api/v1/azureRepos/repositories', azureReposController.getRepositories);

const invoker = new Invoker();

module.exports.handler = ((event, context) => {
    invoker.register('/service', new AzureReposServiceMgr());
    return bcHandler(handler, invoker)(event, context);
});