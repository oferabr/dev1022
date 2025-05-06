const { publishEvent, BcEventName, CustomerAdoptionProgressStepEnum } = require('@bridgecrew/events');
const AWS = require('aws-sdk');
const { InternalServerError, BadRequestError } = require('@bridgecrew/api');
const RemoteLambda = require('@bridgecrew/nodeUtils/remoteLambda/invoke');
const epsagon = require('epsagon');
const {
    RepositoriesConfigurationService,
    RepositoriesGroup,
    CustomerConfigurationsService,
    CustomerConfigurations,
    RepositoriesToGroups,
    RepositoriesGroupFilterSeverity,
    RepositoriesGroupFilterPath,
    RepositoriesGroupFilterPolicy,
    IncidentConfiguration,
    Tenant,
    RepositoriesGroupPrismaNotificationIntegration
} = require('@bridgecrew/dal-layer');

const customerApiRemoteLambda = new RemoteLambda(process.env.CUSTOMERS_API_LAMBDA);
const { FEATURE_TYPES, CONFIGURATIONS } = require('@bridgecrew/nodeUtils/models/Enums');
const { v4 } = require('uuid');
const RepoGroupPrismaNotificationIntegrationsService = require('../services/RepoGroupPrismaNotificationIntegrationsService');
const DEFAULT_SCHEME = require('../conf/defaultScheme.json');

const BRIDGECREW_DOMAIN = process.env.DOMAIN_NAME;

class VcsSettingsServiceMgr {
    constructor() {
        this.customerName = null;
        this.SSM = new AWS.SSM();
        this.reposConfService = new RepositoriesConfigurationService();
        this.customerConfService = new CustomerConfigurationsService();
        this.repoGroupPrismaNotificationIntegrationsService = new RepoGroupPrismaNotificationIntegrationsService();
    }

    init({ customerName }) {
        this.customerName = customerName;
        epsagon.label('customerName', this.customerName);
    }

    fillDefaultScheme(scheme, repos) {
        const filledScheme = scheme;
        for (const type of Object.keys(scheme)) {
            const schemeKeys = Object.keys(scheme[type]);
            const rule = DEFAULT_SCHEME[type];
            if (rule && (schemeKeys.length === 0 || (schemeKeys.length === 1 && schemeKeys[0] === 'enabled'))) filledScheme[type].sections = [{ repos, rule, isDefault: true }];
        }

        return filledScheme;
    }

    async getClientScheme({ customerName, permittedAccounts = null }) {
        this.init({ customerName });
        let repos = await customerApiRemoteLambda.invoke('getCustomerAccountIdsByName', { name: this.customerName });
        const permittedAccountsObject = Array.isArray(permittedAccounts) ? {} : null;
        if (Array.isArray(permittedAccounts)) {
            for (const repositoryName of permittedAccounts) {
                permittedAccountsObject[repositoryName] = true;
            }
        }
        repos = repos.filter(repo => !repo.match(/(\d+){12}/g) && (!permittedAccountsObject || permittedAccountsObject[repo])); // filter out aws accounts & permitted accounts
        const data = await this.reposConfService.getReposConfByCustomerAndRepos(this.customerName);
        const filteredData = [];
        for (const repoGroup of data) {
            const { repoNames } = repoGroup;
            const filteredRepoNames = permittedAccounts ? repoNames.filter(repoName => permittedAccountsObject[repoName]) : repoNames;
            if (Array.isArray(filteredRepoNames) && filteredRepoNames.length > 0) {
                repoGroup.repoNames = filteredRepoNames;
                filteredData.push(repoGroup);
            }
        }
        const customerConf = await this.customerConfService.getCustomerConf(this.customerName);
        let { scheme } = await this.dbToScheme({ data: filteredData, customerConf });
        scheme = this.fillDefaultScheme(scheme, repos);
        console.info('getScheme:scheme', JSON.stringify(scheme));
        return scheme;
    }

    async _fillDefaultWhenEmpty(scheme, repos) {
        const newScheme = scheme;
        const featureTypes = [FEATURE_TYPES.codeReviews, FEATURE_TYPES.prComments];
        const data = await this.reposConfService.getReposConfByCustomerAndRepos(this.customerName, []);
        console.info('fillDefaultWhenEmpty:data', JSON.stringify(data));
        for (const type of featureTypes) {
            const dataForType = data.filter(feature => feature.featureType === type);
            console.info('fillDefaultWhenEmpty:data for type', type, JSON.stringify(dataForType));
            const rule = DEFAULT_SCHEME[type];
            if (dataForType.length === 0) newScheme[type].sections = [{ repos, rule }];
        }
        if (Object.keys(newScheme[FEATURE_TYPES.scannedFiles]).length === 0) newScheme[FEATURE_TYPES.scannedFiles].sections = [{ repos, rule: DEFAULT_SCHEME[FEATURE_TYPES.scannedFiles] }];
        console.info('fillDefaultWhenEmpty:newScheme', JSON.stringify(newScheme));
        return newScheme;
    }

    async getScheme({ customerName, fullRepoName } = {}) {
        console.info('getScheme:customerName, fullRepoName', customerName, fullRepoName);
        this.init({ customerName });
        const repos = typeof fullRepoName === 'string' ? [fullRepoName] : fullRepoName;
        const [data, customerConf] = await Promise.all([
            this.reposConfService.getReposConfByCustomerAndRepos(this.customerName, repos),
            this.customerConfService.getCustomerConf(this.customerName)
        ]);
        let { scheme } = await this.dbToScheme({ data, customerConf });
        console.info('getScheme:scheme before fill', JSON.stringify(scheme));
        scheme = await this._fillDefaultWhenEmpty(scheme, repos);
        return scheme;
    }

    async notifyCustomerProgress(customerName, adopted) {
        const event = {
            eventName: BcEventName.CUSTOMER_ADOPTION_PROGRESS,
            payload: {
                customerName,
                progressStep: CustomerAdoptionProgressStepEnum.NOTIFICATION_ENABLED,
                adopted
            }
        };
        await publishEvent(event);
        console.info(`Published a ${BcEventName.CUSTOMER_ADOPTION_PROGRESS} event where adopted=${adopted}`);
    }

    async updateScheme({ customerName, scheme, type, isFromController }) {
        this.init({ customerName });
        const { repoGroupsArr, reposToGroupsArr, scannedFilesFilterArr, policiesFilterArr, severityFilterArr, pcNotificationsIntegrations, isExternalIntegrationNotificationsEnabled, customerConf } = await this.schemeToDb({
            customerName: this.customerName,
            scheme,
            type
        });
        const customerConfRes = await this.customerConfService.saveCustomerConf(new CustomerConfigurations({ customerName: new Tenant({ id: this.customerName }), configurations: customerConf }));
        if (repoGroupsArr && repoGroupsArr.length > 0) {
            await this.reposConfService.deleteRepoGroupScheme(repoGroupsArr.map(repoGroup => repoGroup.repoGroupId));
        }
        const res = await this.reposConfService.saveReposGroupsConf({
            reposToGroups: reposToGroupsArr,
            repoGroupFilterPaths: scannedFilesFilterArr,
            repoGroupFilterSeverity: severityFilterArr,
            repoGroupFilterPolicies: policiesFilterArr,
            repoGroupPcNotifications: pcNotificationsIntegrations
        });
        if (scheme[FEATURE_TYPES.pcNotifications] && isFromController && res && customerConfRes) {
            await this.notifyCustomerProgress(customerName, isExternalIntegrationNotificationsEnabled);
        }
        console.info('updateScheme:res', JSON.stringify(res));
        console.info('savedCustomerConf:res', JSON.stringify(customerConfRes));
        return res;
    }

    async addReposToDefaultConf({ customerName, repositories, totalCustomerReposCount }) {
        this.init({ customerName });
        const data = await this.reposConfService.getReposConfByCustomerAndRepos(this.customerName);
        const customerConf = await this.customerConfService.getCustomerConf(this.customerName);
        const { scheme } = await this.dbToScheme({ data, customerConf });

        console.log('scheme before update', JSON.stringify(scheme));
        console.log('repositories', repositories);

        const typesToUpdate = [];
        for (const type of Object.keys(scheme)) {
            let featureRepos = [];
            if (scheme[type].sections) {
                const defaultSection = scheme[type].sections.filter(section => section.isDefault);
                console.log('defaultSection', JSON.stringify(defaultSection));
                if (defaultSection.length) featureRepos = defaultSection[0].repos;
            }
            console.log('featureRepos', featureRepos);

            if (type === FEATURE_TYPES.scannedFiles) {
                if (totalCustomerReposCount && featureRepos && featureRepos.length === totalCustomerReposCount) typesToUpdate.push(type);
            } else if (featureRepos && featureRepos.length) typesToUpdate.push(type);
        }

        console.log('typesToUpdate', typesToUpdate);

        for (const type of typesToUpdate) {
            scheme[type].sections[0].repos = scheme[type].sections[0].repos.concat(repositories);
            console.log('updated scheme', JSON.stringify(scheme));
            await this.updateScheme({ customerName, scheme, type });
            console.log('finish update scheme for type', type);
        }
    }

    async schemeToDb({ customerName, scheme, type }) {
        let currentCustomerConf = await this.customerConfService.getCustomerConf(customerName);
        if (!currentCustomerConf) {
            currentCustomerConf = {};
            currentCustomerConf.configurations = [];
        }
        const scannedFilesFilterArr = [], severityFilterArr = [];
        let isExternalIntegrationNotificationsEnabled = false;
        let repoGroupsArr = [], reposToGroupsArr = [], policiesFilterArr = [], existingRepoGroups = [], pcNotificationsIntegrations = [];
        const featureTypes = type ? [type] : Object.keys(FEATURE_TYPES);
        for (const featureType of featureTypes) {
            if (featureType === FEATURE_TYPES.pcNotifications) {
                isExternalIntegrationNotificationsEnabled = scheme[featureType].enabled;
            }
            if (scheme[featureType].enabled) {
                currentCustomerConf.configurations.push(CONFIGURATIONS[featureType]);
            } else if (scheme[featureType].enabled === false) {
                const index = currentCustomerConf.configurations.indexOf(CONFIGURATIONS[featureType]);
                if (index > -1) {
                    currentCustomerConf.configurations.splice(index, 1);
                }
            }
            existingRepoGroups = await this.reposConfService.getRepoGroups({ featureType, customerName });
            repoGroupsArr = repoGroupsArr.concat(existingRepoGroups);
            const { sections } = scheme[featureType];
            if (sections) {
                for (const section of sections) {
                    const repoGroupId = section.id ? section.id : v4();
                    const { repos, rule, isDefault } = section;
                    const repoGroup = new RepositoriesGroup({ repoGroupId, featureType: FEATURE_TYPES[featureType], customerName, isDefault });
                    reposToGroupsArr = reposToGroupsArr.concat(repos.map(repoName => new RepositoriesToGroups({ repoGroup, repoName })));
                    switch (featureType) {
                        case FEATURE_TYPES.yorTag:
                        case FEATURE_TYPES.scannedFiles:
                            scannedFilesFilterArr.push(new RepositoriesGroupFilterPath({ repoGroup, pathRegex: rule.excludePaths }));
                            break;
                        case FEATURE_TYPES.codeReviews:
                        case FEATURE_TYPES.prComments:
                            severityFilterArr.push(new RepositoriesGroupFilterSeverity({ repoGroup, severity: rule.severityLevel }));
                            policiesFilterArr = policiesFilterArr.concat(rule.excludePolicies.map(policy => new RepositoriesGroupFilterPolicy({ repoGroup, policy: new IncidentConfiguration({ incidentId: policy }) })));
                            break;
                        case FEATURE_TYPES.pcNotifications:
                            severityFilterArr.push(new RepositoriesGroupFilterSeverity({ repoGroup, severity: rule.severityLevel }));
                            policiesFilterArr = policiesFilterArr.concat(rule.excludePolicies.map(policy => new RepositoriesGroupFilterPolicy({ repoGroup, policy: new IncidentConfiguration({ incidentId: policy }) })));
                            pcNotificationsIntegrations = pcNotificationsIntegrations.concat(
                                rule.pcNotificationIntegrations.map(({ integrationId, templateId }) => new RepositoriesGroupPrismaNotificationIntegration({
                                    repoGroup, prismaNotificationIntegrationId: integrationId, prismaNotificationTemplateId: templateId
                                }))
                            );
                            break;
                        default:
                            break;
                    }
                }
            }
        }
        return { repoGroupsArr, reposToGroupsArr, scannedFilesFilterArr, policiesFilterArr, severityFilterArr, pcNotificationsIntegrations, isExternalIntegrationNotificationsEnabled, customerConf: [...new Set(currentCustomerConf.configurations)] };
    }

    async dbToScheme({ data, customerConf }) {
        const scheme = {};
        Object.keys(FEATURE_TYPES).forEach(type => {
            scheme[type] = (type === FEATURE_TYPES.scannedFiles) ? {} : { enabled: !!(customerConf && customerConf.configurations.includes(CONFIGURATIONS[type])) };
        });
        for (const repoGroup of data) {
            const { repoGroupId, featureType, repoNames, pathRegex, policies, severity, isDefault, prismaNotificationIntegrations } = repoGroup;
            if (!scheme[featureType].sections) scheme[featureType].sections = [];
            const rule = [FEATURE_TYPES.yorTag, FEATURE_TYPES.scannedFiles].includes(featureType) ? { excludePaths: pathRegex } : { severityLevel: severity, excludePolicies: policies || [] };
            if (featureType === FEATURE_TYPES.pcNotifications) {
                if (!prismaNotificationIntegrations) {
                    console.warn(`[dbToScheme] prismaNotificationIntegrations is ${prismaNotificationIntegrations}. that should never be empty`);
                    rule.pcNotificationIntegrations = [];
                } else {
                    // eslint-disable-next-line camelcase
                    rule.pcNotificationIntegrations = prismaNotificationIntegrations.map(({ integration_id, template_id }) => ({
                        integrationId: integration_id, templateId: template_id
                    }));
                }
            }
            scheme[featureType].sections.push({ id: repoGroupId, repos: repoNames || [], rule, isDefault });
        }
        return { scheme };
    }

    async getCustomerPlatformBaseURL({ customerName }) {
        await this.getPrismaDomainName();
        const bcResp = {
            domain: BRIDGECREW_DOMAIN,
            isPrisma: false
        };
        const pcResp = {
            domain: this.prismaDomainName,
            isPrisma: true
        };

        const customer = await this._getCustomerByName(customerName);
        pcResp.prismaId = customer.prisma_id;

        if (!customer.created_by) return bcResp;

        const customerConf = await this.customerConfService.getCustomerConf(customerName);
        const data = await this.reposConfService.getReposConfByCustomerAndRepos(customerName);
        const { scheme } = await this.dbToScheme({ data, customerConf });
        if (scheme.PC_LINKS) return pcResp;

        if (customer.created_by === 'bridgecrew') {
            return customer.prisma_id ? pcResp : bcResp;
        }

        return pcResp;
    }

    async _getCustomerByName(customerName) {
        const customer = await customerApiRemoteLambda.invoke('getCustomerByName', { name: customerName });
        return customer;
    }

    async getPrismaDomainName() {
        if (this.prismaDomainName) {
            return this.prismaDomainName;
        }

        return this.SSM.getParameter({
            Name: process.env.PRISMA_ENV_BASE_URL_PARAMETER,
            WithDecryption: true
        }).promise().then(value => {
            console.log('ssm value', value);
            const val = (value.Parameter && value.Parameter.Value) || '';
            this.prismaDomainName = val.slice(0, -1);
            return val;
        });
    }

    async deletePcNotificationIntegrationByIds({ prismaNotificationIntegrationIds }) {
        if (!Array.isArray(prismaNotificationIntegrationIds)) {
            throw new BadRequestError('prismaNotificationIntegrationIds must be an array');
        }

        if (prismaNotificationIntegrationIds.length == 0) {
            return;
        }

        console.log(`[deletePcNotificationIntegrationByIds] deleting prismaNotificationIntegrationIds ${prismaNotificationIntegrationIds}`);
        try {
            await this._deleteEmptyRepoGroupsScheme([...new Set(prismaNotificationIntegrationIds)]);

            await this.repoGroupPrismaNotificationIntegrationsService.deleteRepoGroupsPcNotificationIntegrations(prismaNotificationIntegrationIds);
        } catch (error) {
            console.error('failed to delete prismaNotificationIntegrationId', error);
            throw new InternalServerError('failed to delete prismaNotificationIntegrationId');
        }
    }

    async _deleteEmptyRepoGroupsScheme(prismaNotificationIntegrationIds) {
        const repoGroupsNotifications = await this.repoGroupPrismaNotificationIntegrationsService.getRepoGroupsPcNotificationIntegrations(prismaNotificationIntegrationIds);
        const repoGroupsToNotificationsToDelete = repoGroupsNotifications.reduce((res, { repoGroupId, prismaNotificationIntegrationId }) => {
            res[repoGroupId] = res[repoGroupId] ? res[repoGroupId] + 1 : 1;
            return res;
        }, {});
        const repoGroupsIds = Object.keys(repoGroupsToNotificationsToDelete);

        console.log(`[_deleteEmptyRepoGroupsScheme] checking if need to delete ${repoGroupsIds}`);
        const repoGroups = await this.reposConfService.getRepoGroupByIds(repoGroupsIds, ['reposGroupPrismaNotificationIntegration']);

        // if number of notifications in repoGroup equals number of notifications to delete from this repoGroup then delete it
        const repoGroupsToDelete = repoGroups.reduce((result, { repoGroupId, reposGroupPrismaNotificationIntegration }) => {
            if (repoGroupsToNotificationsToDelete[repoGroupId] === reposGroupPrismaNotificationIntegration.length) {
                result.push(repoGroupId);
            }
            return result;
        }, []);

        console.log(`[_deleteEmptyRepoGroupsScheme] deleting following repo groups: ${repoGroupsToDelete}`);
        if (repoGroupsToDelete.length) {
            await this.reposConfService.deleteRepoGroupScheme(repoGroupsToDelete);
        }
    }
}

module.exports = { VcsSettingsServiceMgr };
