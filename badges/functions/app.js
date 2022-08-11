const { Invoker, getBCExpressRouter, bcHandler } = require('@bridgecrew/api');
const badgesController = require('./controller');
const { BadgesService } = require('./service');

const app = getBCExpressRouter();

app.get('/api/v1/badges/:vcs/:repoOwner/:repoName', badgesController.getBadges);

const invoker = new Invoker();
invoker.register('/badges', new BadgesService());

module.exports.handler = bcHandler(app, invoker);
