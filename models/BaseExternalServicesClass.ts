import { SOURCE_TYPES, MODULE_TYPE } from '@bridgecrew/nodeUtils/models/Enums';
import * as vcsSsmMgr from '@bridgecrew/vcs-ssm-mgr';
import * as RemoteLambda from '@bridgecrew/nodeUtils/remoteLambda/invoke';
import { Repository } from '@bridgecrew/dal-layer';

const settingsMgrApiLambda = new RemoteLambda(process.env.SETTINGS_MGR_API_LAMBDA);
const integrationApiRemoteLambda = new RemoteLambda(process.env.INTEGRATION_API_LAMBDA);
const repositoriesApiLambda = new RemoteLambda(process.env.REPOSITORIES_API_LAMBDA);

/**
 * @deprecated soon, please make sure to update any class changes on src/packages/vcs-classes/src/models/BaseExternalServicesClass.ts
 */
export abstract class BaseExternalServicesClass {
    customerName: string;
    sourceType: SOURCE_TYPES;
    module: MODULE_TYPE;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    apiManager: any;
    apiGatewayUrl: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vcsSSmMgrInstance: any;

    constructor({ customerName, sourceType }: { customerName: string, sourceType: string }) {
        this.customerName = customerName;
        this.sourceType = sourceType;
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        this.vcsSSmMgrInstance = vcsSsmMgr.getInstance();
    }

    async getIntegrationData({ organizationName, customerName }: { organizationName: string, customerName?: string }) {
        this.customerName = customerName || this.customerName;
        console.info(`getting ${this.customerName} integration data`);
        const params = {
            customerName: this.customerName,
            type: this.sourceType
        };
        const integrationResponse = await integrationApiRemoteLambda.invoke('getByType', params);
        console.log(`Function: _getIntegrationData - The ${this.sourceType} integration for ${this.customerName} is ${JSON.stringify(integrationResponse)}`);
        const existingIntegration = (organizationName && integrationResponse) ? integrationResponse.filter(integration => integration.params.organization.name === organizationName) : integrationResponse;
        const integrationData = existingIntegration && existingIntegration.length ? existingIntegration[0].params : null;
        const { module } = integrationData || {};
        this.module = module;
        if (!this.module) {
            const { isPrisma } = await settingsMgrApiLambda.invoke('vcsSettings/getCustomerPlatformBaseURL', { customerName: this.customerName });
            this.module = isPrisma ? MODULE_TYPE.PC : MODULE_TYPE.BC;
        }
        this.apiGatewayUrl = await this.vcsSSmMgrInstance.getGlobalRedirectUrl(this.module);
        return integrationData;
    }

    abstract init()

    async saveRepositories(repositories: Array<Repository>) {
        await repositoriesApiLambda.invoke('repositoriesService/saveRepositories', { repositories });
    }
}