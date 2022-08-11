const axios = require('axios');
const querystring = require('querystring');
const axiosRetry = require('axios-retry');
const config = require('../conf/config').auth;

const ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
/**
 * Class for managing tokens via Azure DevOps using oauth flow
 * How it works?
 * First Time:
 * The client needs to call: https://app.vssps.visualstudio.com/oauth2/authorize?client_id={client_id}&response_type=Assertion&state={customer_name}&scope={scopes}
 * After redirect to Azure DevOps authorization window, Azure DevOps server call to {api-gateway}/api/v1/integration/azureRepos path with the temp code
 * using the temp code we generate access token + refresh token
 * Every time (besides the first one):
 * by using the refresh token we generate the access token
 */

class TokenManager {
    constructor({ code, refreshToken, clientAssertion, options = {} }) {
        if (!code && !refreshToken && !options.module) throw new Error('can\'t create new TokenManager without code or refreshToken and module');

        this.code = code || null;
        this.refreshToken = refreshToken || null;
        this.module = options.module || null;
        this.apiUrl = options.apiUrl || null;
        this.clientAssertion = clientAssertion || null;

        this.redirectUri = this.apiUrl ? this.apiUrl.replace(/\/integrations\/azureRepos$/, `/global/integrations/vcs/auth/${this.module}`) : null;

        this.axiosInstance = axios.create({
            baseURL: config.baseURL,
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        axiosRetry(this.axiosInstance, {
            retries: 3,
            retryDelay: (retryCount) => {
                console.warn(`request failed with status code >= 500, retry number: ${retryCount}`);
                return 5000; // 1sec delay
            },
            retryCondition: e => axiosRetry.isNetworkOrIdempotentRequestError(e) && e?.response?.status && typeof e?.response?.status === 'number' && e?.response?.status >= 500 // retry only when status code is >= 500
        });
    }

    static _handleAzureReposExceptions(error, returnError) {
        if (!error) return;
        const { response } = error;
        if (!response) return;
        const { status, statusText, data } = response;
        if (status || statusText || data) {
            console.error('got error from AzureDevOps API (OAUTH2):\n'
                + `status: ${status}\n`
                + `statusText: ${statusText}\n`
                + `data: ${data ? JSON.stringify(data) : null}`);
            if (returnError) return { status, statusText, data };
        }
    }

    async init(apiUrl) {
        if (apiUrl) {
            this.apiUrl = apiUrl;
            this.redirectUri = this.apiUrl.replace(/\/?$/, `/global/integrations/vcs/auth/${this.module}`);
        }
    }

    /**
     * get the access token + refresh token
     * depends of the constructor param (code or refreshToken)
     * generate new access token
     * @returns {Promise<{access_token, scopes, expires_in, refresh_token, token_type}>}
     */
    async getTokenData(returnError) {
        try {
            const data = {
                client_assertion_type: ASSERTION_TYPE,
                grant_type: this.code ? GRANT_TYPE : 'refresh_token',
                client_assertion: encodeURIComponent(this.clientAssertion),
                assertion: this.code ? encodeURIComponent(this.code) : encodeURIComponent(this.refreshToken),
                redirect_uri: this.redirectUri
            };
            console.log('the token data: ', JSON.stringify(data));
            const res = await this.axiosInstance.request({
                method: 'post',
                data: querystring.stringify(data)
            });
            return res.data;
        } catch (e) {
            const error = TokenManager._handleAzureReposExceptions(e, returnError);
            console.error(`failed to get token data: ${e}`);
            if (returnError) throw new Error(JSON.stringify((error)));
            throw e;
        }
    }
}

module.exports = TokenManager;
