const epsagon = require('epsagon');
const { VCS_ERROR_CODES, SOURCE_TYPES } = require('@bridgecrew/nodeUtils/models/Enums');
const { VCS_ERROR_PHASES, ERROR_HIGH_CLASSIFICATION_RATIO, ERROR_CLASSIFICATION } = require('./errorEnums');
/**
 * @deprecated soon, please make sure to update any class changes on src/packages/vcs-classes/src/models/errorHandlingBaseClass.js
 */
class ErrorHandlingBaseClass {
    constructor(sourceType) {
        this.sourceType = sourceType;
        this.errorLogger = {
            [VCS_ERROR_PHASES.SYNC_REPOSITORIES]: { failed: 0, total: 0, errorsByStatusCode: {} },
            [VCS_ERROR_PHASES.GET_REPOSITORIES_FILES_STRUCTURE]: { failed: 0, total: 0, errorsByStatusCode: {} },
            [VCS_ERROR_PHASES.DOWNLOAD_FILES]: { failed: 0, total: 0, errorsByStatusCode: {} }
        };
    }

    get SYNC_REPOSITORIES_PHASE_NAME() {
        return VCS_ERROR_PHASES.SYNC_REPOSITORIES;
    }

    get GET_REPOSITORIES_FILES_STRUCTURE_PHASE_NAME() {
        return VCS_ERROR_PHASES.GET_REPOSITORIES_FILES_STRUCTURE;
    }

    get DOWNLOAD_FILES_PHASE_NAME() {
        return VCS_ERROR_PHASES.DOWNLOAD_FILES;
    }

    _updateErrorLog(phase, statusCode = null) {
        this.errorLogger[phase].failed++;
        if (statusCode) {
            if (!this.errorLogger[phase].errorsByStatusCode[statusCode]) {
                this.errorLogger[phase].errorsByStatusCode[statusCode] = 0;
            }
            this.errorLogger[phase].errorsByStatusCode[statusCode]++;
        }
    }

    /**
     * Check if trigger error should be skipped
     * @param vcsError
     * @returns {boolean}
     * @private
     */
    _shouldSkipError(vcsError) {
        // Avoid sending error to monitoring app when only one 404 - error occurs in Azure Repos or GithubEnterprise
        if ([SOURCE_TYPES.GITHUB_ENTERPRISE, SOURCE_TYPES.AZURE_REPOS].includes(this.sourceType)
            && vcsError?.vcsStatusCode === 404
            && (vcsError?.vcsErrorPhase === VCS_ERROR_PHASES.GET_REPOSITORIES_FILES_STRUCTURE || vcsError?.vcsErrorPhase === VCS_ERROR_PHASES.DOWNLOAD_FILES)
            && this.errorLogger[vcsError.vcsErrorPhase]?.failed === 1) {
            console.log('error skipped', vcsError);
            return true;
        }
        return false;
    }

    /**
     * create epsagon custom labels for easy monitoring
     * @param vcsError
     * @private
     */
    _addEpsagonCustomLabels(vcsError) {
        epsagon.label('customerName', vcsError.customerName);
        epsagon.label('vcsName', vcsError.vcsName);
        epsagon.label('vcsErrorMessage', vcsError.message);
        if (vcsError?.vcsStatusCode) {
            epsagon.label('vcsErrorStatusCode', vcsError.vcsStatusCode);
        }
        if (vcsError?.originalMessage) {
            epsagon.label('errorOriginalMessage', vcsError.originalMessage);
        }
        if (vcsError?.originalStatusCode) {
            epsagon.label('errorOriginalStatusCode', vcsError?.originalStatusCode);
        }
        if (vcsError?.errorClassification) {
            epsagon.label('vcsErrorClassification', vcsError?.errorClassification);
        }
        if (vcsError.vcsDetails && Object.keys(vcsError.vcsDetails).length > 0) {
            epsagon.label('vcsErrorDetails', JSON.stringify(vcsError.vcsDetails));
        }
        if (vcsError.errorPhaseLog && Object.keys(vcsError.errorPhaseLog).length > 0) {
            epsagon.label('vcsErrorPhaseLog', JSON.stringify(vcsError.errorPhaseLog));
        }
    }

    /**
     * Normalize error message and status code
     * @param message { string }
     * @param statusCode { number }
     * @param customerName { string }
     * @returns {{vcsStatusCode: number, vcsMessage: (string|*)}|{vcsStatusCode, vcsMessage}}
     * @private
     */
    _vcsCreateCustomErrorMessageAndCode(message, statusCode, customerName) {
        const code = parseInt(statusCode, 10);
        if (Number.isNaN(code)) return { vcsMessage: message, vcsStatusCode: statusCode };
        const VCS_ERROR_CUSTOM_MESSAGES = {
            [VCS_ERROR_CODES.BAD_REQUEST]: 'bad request',
            [VCS_ERROR_CODES.UNAUTHORIZED]: 'permission denied',
            [VCS_ERROR_CODES.FORBIDDEN]: 'forbidden',
            [VCS_ERROR_CODES.NOT_FOUND]: 'not found',
            [VCS_ERROR_CODES.UNPROCESSABLE_ENTITY]: 'unprocessable entity',
            [VCS_ERROR_CODES.INTERNAL_ERROR]: 'internal error'
        };
        // TODO: Create some logic to convert status code / message for sites with strange error codes (for example Terraform-Enterprise always return 404)
        return {
            vcsMessage: VCS_ERROR_CUSTOM_MESSAGES[code]
                ? `VCS ${this.sourceType} error customer ${customerName} - ${VCS_ERROR_CUSTOM_MESSAGES[statusCode]}`
                : message,
            vcsStatusCode: code
        };
    }

    /**
     * extract status code and message from error object
     * @param err
     * @returns {{message: string, statusCode: number}}
     * @private
     */
    _extractDetailsFromError(err) {
        if (err.isAxiosError) {
            return {
                message: err?.response?.data?.message || err.response?.message || err?.message,
                statusCode: err?.response?.status || err?.status || err?.statusCode || VCS_ERROR_CODES.BAD_REQUEST
            };
        }
        const statusCode = err?.status || err?.statusCode || VCS_ERROR_CODES.INTERNAL_ERROR;
        // eslint-disable-next-line camelcase
        const message = err?.message;
        return { message, statusCode };
    }

    /**
     * wrap error object with extra VCS data
     * @param err
     * @param customerName
     * @param extraDetails
     * @param phase
     */
    wrapErrorWithVCSData(err, customerName, extraDetails = {}, phase = null) {
        const errorDetails = this._extractDetailsFromError(err);
        const originalStatusCode = errorDetails?.statusCode || VCS_ERROR_CODES.INTERNAL_ERROR;
        const originalMessage = errorDetails?.message || err?.message;
        const { vcsMessage, vcsStatusCode } = this._vcsCreateCustomErrorMessageAndCode(originalMessage, originalStatusCode, customerName);
        // eslint-disable-next-line no-param-reassign
        err.vcsName = this.sourceType;
        // eslint-disable-next-line no-param-reassign
        err.customerName = customerName;
        // eslint-disable-next-line no-param-reassign
        err.message = vcsMessage;
        // eslint-disable-next-line no-param-reassign
        err.originalMessage = originalMessage;
        // eslint-disable-next-line no-param-reassign
        err.originalStatusCode = originalStatusCode;
        // eslint-disable-next-line no-param-reassign
        err.vcsStatusCode = vcsStatusCode;
        // eslint-disable-next-line no-param-reassign
        err.vcsDetails = extraDetails;
        if (phase && this.errorLogger[phase]) {
            // eslint-disable-next-line no-param-reassign
            err.vcsErrorPhase = phase;
            const errorHighClassificationRatio = ERROR_HIGH_CLASSIFICATION_RATIO[phase] || 0.1; // default ratio 10%
            this._updateErrorLog(phase, vcsStatusCode);
            const classification = this.errorLogger[phase]
            && this.errorLogger[phase]?.total
            && this.errorLogger[phase].failed / this.errorLogger[phase].total > errorHighClassificationRatio ? ERROR_CLASSIFICATION.HIGH : ERROR_CLASSIFICATION.LOW;
            // eslint-disable-next-line no-param-reassign
            err.errorPhaseLog = {
                phase,
                ...this.errorLogger[phase]
            };
            // eslint-disable-next-line no-param-reassign
            err.errorClassification = classification;
        }
        this._addEpsagonCustomLabels(err);
    }

    /**
     *
     * @param err
     * @param customerName
     * @param extraDetails
     * @param phase
     */
    sendErrorToMonitoringApp(err, customerName, extraDetails = {}, phase = null) {
        this.wrapErrorWithVCSData(err, customerName, extraDetails, phase);
        console.error(`Error in '${this.sourceType}'`, err);
        this.setErrorInMonitoringApp(err);
    }

    /**
     * set error indication in monitoring app
     * @param vcsError
     */
    setErrorInMonitoringApp(vcsError) {
        if (this._shouldSkipError(vcsError)) return;
        epsagon.setError(vcsError);
    }

    /**
     * error logger - increase total in phase
     * @param phase
     * @param total
     */
    errorPhaseIncreaseTotal(phase, total) {
        if (!this.errorLogger[phase]) {
            this.errorLogger[phase] = { failed: 0, total: 0, errorsByStatusCode: {} };
        }
        this.errorLogger[phase].total += total;
    }
}

module.exports = ErrorHandlingBaseClass;