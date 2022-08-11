class BaseVCSDefinition {
    constructor({ remoteLambda, functionName }) {
        this._remoteLambda = remoteLambda;
        this._functionName = functionName;
    }

    async executeMakePullRequest({ prParams }) {
        console.log(`invoking: ${this._functionName} with pr params:\n${JSON.stringify(prParams)}`);
        const serviceManagerPRResponse = await this._remoteLambda.invoke(this._functionName, prParams, null, { noBody: true });
        console.log(`serviceManagerPRResponse=\n${JSON.stringify(serviceManagerPRResponse)}`);
        return serviceManagerPRResponse;
    }

    getEncoding() {
        return 'utf8';
    }

    addAdditionalPRParams() {
        console.info('no additional PR params');
        return {};
    }
}

module.exports = BaseVCSDefinition;