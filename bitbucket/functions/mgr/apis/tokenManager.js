const axios = require('axios');
const querystring = require('querystring');
const { SOURCE_TYPES } = require('@bridgecrew/nodeUtils/models/Enums');
const vcsSSmMgr = require('@bridgecrew/vcs-ssm-mgr');
const config = require('../conf/config').auth;

const AUTHORIZATION_CODE = 'authorization_code';
const REFRESH_TOKEN = 'refresh_token';
/**
 * Class for managing tokens via Bitbucket using oauth flow
 * More details: https://confluence.atlassian.com/bitbucket/oauth-on-bitbucket-cloud-238027431.html
 * How it works?
 * First Time:
 * The client needs to call: https://bitbucket.org/site/oauth2/authorize?client_id={client_id}&response_type=code&state={customer_name}
 * After redirect to BitBucket authorization window, BitBucket server call to {api-gateway}/api/v1/integration/bitbucket path with the temp code
 * using the temp code we generate access token + refresh token
 * Every time (besides the first one):
 * by using the refresh token we generate the access token
 */

class TokenManager {
    constructor({ code, refreshToken, clientId, secret, module }) {
        if (!code && !refreshToken) throw new Error('can\'t create new TokenManager without code or refreshToken');

        this.module = module;
        this.code = code || null;
        this.refreshToken = refreshToken || null;
        this.vcsSSmMgrInstance = vcsSSmMgr.getInstance();
        this.axiosInstance = axios.create({
            baseURL: config.baseURL,
            auth: { username: clientId, password: secret },
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });
    }

    static _handleBitBucketExceptions(error, returnError) {
        if (!error) return;
        const { response } = error;
        if (!response) return;
        const { status, statusText, data } = response;
        if (status || statusText || data) {
            console.error('got error from BitBucket API (OAUTH2):\n'
                + `status: ${status}\n`
                + `statusText: ${statusText}\n`
                + `data: ${data ? JSON.stringify(data) : null}`);

            if (returnError) return { status, statusText, data };
        }
    }

    async init() {
        const username = await this.vcsSSmMgrInstance.getClientId(SOURCE_TYPES.BITBUCKET, this.module);
        const password = await this.vcsSSmMgrInstance.getClientSecret(SOURCE_TYPES.BITBUCKET, this.module);

        this.axiosInstance = axios.create({
            baseURL: config.baseURL,
            auth: { username, password },
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });
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
                grant_type: this.code ? AUTHORIZATION_CODE : REFRESH_TOKEN
            };

            if (this.code) {
                data.code = this.code;
            } else {
                data.refresh_token = this.refreshToken;
            }

            const accessTokenResponse = await this.axiosInstance.request({
                method: 'post',
                data: querystring.stringify(data)
            });

            return accessTokenResponse.data;
        } catch (e) {
            const error = TokenManager._handleBitBucketExceptions(e, returnError);
            console.error(`failed to get token data: ${e}`);
            if (returnError) throw new Error(JSON.stringify((error)));
            throw e;
        }
    }
}

module.exports = TokenManager;
