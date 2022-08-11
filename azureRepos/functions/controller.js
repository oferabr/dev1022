const { BadRequestError } = require('@bridgecrew/api');
const { AzureReposServiceMgr } = require('./mgr/azureReposServiceMgr');

const azureReposServiceMgr = new AzureReposServiceMgr();

const getRepositories = async (req, res, next) => {
    try {
        const customerName = req.userDetails.customers[0];
        const integrationId = req.query?.integrationId;
        const data = await azureReposServiceMgr.getRepositories({ customerName, integrationId });
        res.status(200).json(data);
    } catch (err) {
        console.error(err);
        next(new BadRequestError('Failed to fetch repositories'));
    }
};

module.exports = {
    getRepositories
};
