const BaseVCSDefinition = require('./baseVCSDefinition');

class GithubEnterpriseVCSDefinition extends BaseVCSDefinition {
    constructor({ remoteLambda, functionName }) {
        super({ remoteLambda, functionName });
    }

    getEncoding() {
        return 'utf-8';
    }
}

module.exports = GithubEnterpriseVCSDefinition;