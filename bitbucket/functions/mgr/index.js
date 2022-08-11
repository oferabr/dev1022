const serverless = require('serverless-http');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { HttpError, InternalServerError, BadRequestError, addAuthorizerContextToRequest } = require('@bridgecrew/api');
const { BitbucketServiceMgr } = require('./bitbucketServiceMgr');
const { BitbucketEnterpriseServiceMgr } = require('./bitbucketEnterpriseServiceMgr');

const app = express();

app.use(cors());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    if (req.method === 'OPTIONS') {
        res.send(200);
    } else {
        next();
    }
});

app.get('/api/v1/bitbucket/repositories', async (req, res, next) => {
    try {
        const { accounts: permittedAccounts } = req.userDetails;
        const customerName = req.userDetails.customers[0];
        const bitbucketServiceMgr = new BitbucketServiceMgr();
        await bitbucketServiceMgr.init({ customerName, permittedAccounts });
        const data = await bitbucketServiceMgr.getRepositories({});
        res.status(200).json(data);
    } catch (err) {
        console.error(err);
        next(new BadRequestError('Failed to fetch repositories'));
    }
});

app.get('/api/v1/bitbucketEnterprise/repositories', async (req, res, next) => {
    try {
        const { accounts: permittedAccounts } = req.userDetails;
        const customerName = req.userDetails.customers[0];
        const bitbucketEnterpriseServiceMgr = new BitbucketEnterpriseServiceMgr();
        const data = await bitbucketEnterpriseServiceMgr.getRepositories({ customerName, permittedAccounts });
        res.status(200).json(data);
    } catch (err) {
        console.error(err);
        next(new BadRequestError('Failed to fetch repositories'));
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

async function invokeService(funcName, body) {
    const bitbucketServiceMgr = new BitbucketServiceMgr({});

    if (!(bitbucketServiceMgr[funcName] instanceof Function)) {
        throw new BadRequestError('Function does not exist');
    } else {
        return bitbucketServiceMgr[funcName](body);
    }
}

async function invokeEnterpriseService(funcName, body) {
    const bitbucketEnterpriseServiceMgr = new BitbucketEnterpriseServiceMgr({});

    if (!(bitbucketEnterpriseServiceMgr[funcName] instanceof Function)) {
        throw new BadRequestError('Function does not exist');
    } else {
        return bitbucketEnterpriseServiceMgr[funcName](body);
    }
}

exports.handler = (event, context) => {
    if (event.path.startsWith('/invoke')) {
        const matchPattern = event.path.match(/^\/invoke\/([^/]+)(?:\/([^/]+))?$/);
        if (matchPattern.length > 2 && matchPattern[2] !== undefined) {
            if (matchPattern[1] === 'enterprise') {
                return invokeEnterpriseService(matchPattern[2], event.body);
            }
        } else if (matchPattern.length > 2 && matchPattern[2] === undefined) {
            return invokeService(matchPattern[1], event.body);
        } else {
            throw new Error('The invoke not valid');
        }
    } else {
        return serverless(app, {
            request(req, e, ctx) {
                req.event = e;
                req.context = ctx;
                addAuthorizerContextToRequest(req);
            },
            binary: false
        })(event, context);
    }
};
