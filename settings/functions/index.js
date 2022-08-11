const { Invoker, getBCExpressRouter, bcHandler } = require('@bridgecrew/api');
const vcsSettingsController = require('./controller');
const { VcsSettingsServiceMgr } = require('./mgr/vcsSettingsServiceMgr');

const handler = getBCExpressRouter();
handler.get('/api/v1/vcs/settings/scheme', vcsSettingsController.getScheme);
handler.post('/api/v1/vcs/settings/scheme', vcsSettingsController.updateScheme);
handler.get('/api/v1/vcs/settings/scheme/isEnabled', vcsSettingsController.getSchemeEnabled);

const invoker = new Invoker();
invoker.register('/vcsSettings', new VcsSettingsServiceMgr());

module.exports.handler = bcHandler(handler, invoker);
