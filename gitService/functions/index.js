const { Invoker, getBCExpressRouter, bcHandler } = require('@bridgecrew/api');
const GitController = require('./gitController');

const handler = getBCExpressRouter();

const invoker = new Invoker();
invoker.register('/service', GitController);

module.exports.handler = bcHandler(handler, invoker);