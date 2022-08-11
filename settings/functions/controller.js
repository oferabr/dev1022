const { BadRequestError } = require('@bridgecrew/api');
const Joi = require('joi');
const { FEATURE_TYPES } = require('@bridgecrew/nodeUtils/models/Enums');
const { VcsSettingsServiceMgr } = require('./mgr/vcsSettingsServiceMgr');

const vcsSettingsServiceMgr = new VcsSettingsServiceMgr();

const featureScheme = Joi.object({
    enabled: Joi.boolean().required(),
    sections: Joi.array().items({
        id: Joi.string(),
        repos: Joi.array().items(Joi.string()).required(),
        rule: Joi.object({
            severityLevel: Joi.string().required(),
            excludePolicies: Joi.array().items(Joi.string()).required(),
            pcNotificationIntegrations: Joi.when('$type', {
                is: FEATURE_TYPES.pcNotifications,
                then: Joi.array().items({
                    integrationId: Joi.string().required(),
                    templateId: Joi.string()
                }).required()
            })
        }).required(),
        isDefault: Joi.boolean().required()
    }).required()
}).required();

const featureSchemeByType = {
    [FEATURE_TYPES.scannedFiles]: Joi.object().keys({
        sections: Joi.array().items({
            id: Joi.string(),
            repos: Joi.array().items(Joi.string()).required(),
            rule: Joi.object({
                excludePaths: Joi.array().items(Joi.string()).required()
            }).required(),
            isDefault: Joi.boolean().required()
        }).required()
    }).required(),
    [FEATURE_TYPES.codeReviews]: featureScheme,
    [FEATURE_TYPES.prComments]: featureScheme,
    [FEATURE_TYPES.pcLinks]: Joi.object({
        enabled: Joi.boolean().required()
    }).required(),
    [FEATURE_TYPES.pcNotifications]: featureScheme,
    [FEATURE_TYPES.yorTag]: Joi.object().keys({
        enabled: Joi.boolean().required(),
        sections: Joi.array().items({
            id: Joi.string(),
            repos: Joi.array().items(Joi.string()).required(),
            rule: Joi.object({
                excludePaths: Joi.array().items(Joi.string()).required()
            }).required(),
            isDefault: Joi.boolean().required()
        }).required()
    }).required(),
    [FEATURE_TYPES.checkovSuppression]: Joi.object().keys({
        enabled: Joi.boolean().required()
    }).required()
};

const repoSettingsFullScheme = Joi.object().keys({
    [FEATURE_TYPES.scannedFiles]: featureSchemeByType[FEATURE_TYPES.scannedFiles],
    [FEATURE_TYPES.codeReviews]: featureScheme,
    [FEATURE_TYPES.prComments]: featureScheme,
    [FEATURE_TYPES.pcLinks]: featureSchemeByType[FEATURE_TYPES.pcLinks],
    [FEATURE_TYPES.pcNotifications]: featureSchemeByType[FEATURE_TYPES.pcNotifications],
    [FEATURE_TYPES.yorTag]: featureSchemeByType[FEATURE_TYPES.yorTag],
    [FEATURE_TYPES.checkovSuppression]: featureSchemeByType[FEATURE_TYPES.checkovSuppression]
});

const getScheme = async (req, res, next) => {
    try {
        const { customerName, accounts: permittedAccounts } = req.userDetails;
        const data = await vcsSettingsServiceMgr.getClientScheme({ customerName, permittedAccounts });
        res.status(200).json(data);
    } catch (e) {
        console.error(e);
        next(new BadRequestError('Failed to fetch vcs settings scheme'));
    }
};

const getSchemeEnabled = async (req, res, next) => {
    try {
        const { customerName, accounts: permittedAccounts } = req.userDetails;
        const data = await vcsSettingsServiceMgr.getClientScheme({ customerName, permittedAccounts });
        const result = Object.entries(data).reduce((acc, entry) => {
            const { enabled = false } = entry[1];
            return { ...acc, [entry[0]]: { enabled } };
        }, {});
        res.status(200).json(result);
    } catch (e) {
        console.error(e);
        next(new BadRequestError('Failed to fetch vcs settings scheme'));
    }
};

const updateScheme = async (req, res, next) => {
    try {
        const { customerName, accounts: permittedAccounts } = req.userDetails;
        const { scheme, type } = req.body;
        const validationOpts = { context: { type } };
        const schemeError = type ? featureSchemeByType[type].validate(scheme[type], validationOpts).error : repoSettingsFullScheme.validate(scheme, validationOpts).error;
        if (schemeError) {
            console.error(`Provided scheme not valid, Error: ${schemeError.details[0].message}`);
            return res.status(500).send();
        }
        await vcsSettingsServiceMgr.updateScheme({ customerName, scheme, type, isFromController: true });
        const newScheme = await vcsSettingsServiceMgr.getClientScheme({ customerName, permittedAccounts });
        console.info('new updated scheme sent to client:', JSON.stringify(newScheme));
        res.status(200).json(newScheme);
    } catch (e) {
        console.error(e);
        next(new BadRequestError('Failed to update vcs settings scheme'));
    }
};

module.exports = {
    getScheme,
    updateScheme,
    getSchemeEnabled
};
