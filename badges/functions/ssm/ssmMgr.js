const AWS = require('aws-sdk');

const SSM_KEY_DOMAIN_URL = `/base_stack/domain_${process.env.TAG}`;

class SsmMgr {
    constructor() {
        this.SSM = new AWS.SSM();
        this.cache = {};
    }

    async getDomainUrl() {
        if (!this.cache.apiGatewayUrl) {
            const ssmResponse = await this.SSM.getParameter({ Name: SSM_KEY_DOMAIN_URL }).promise();
            this.cache.apiGatewayUrl = ssmResponse.Parameter.Value;
        }
        return this.cache.apiGatewayUrl;
    }
}
let instance;

const getInstance = () => {
    if (!instance) {
        instance = new SsmMgr();
    }
    return instance;
};

module.exports = { getInstance };