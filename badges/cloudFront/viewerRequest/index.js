const querystring = require('querystring');
const { URL } = require('url');

// todo: will be removed once the app will support benchmarks='all'
const BENCHMARKS = ['CIS KUBERNETES V1.5', 'CIS AWS V1.2', 'CIS AZURE V1.1', 'PCI-DSS V3.2', 'NIST-800-53', 'ISO27001', 'SOC2', 'CIS GCP V1.1', 'HIPAA', 'Best practices', 'FEDRAMP (MODERATE)',
    'PCI-DSS V3.2.1', 'CIS AWS V1.3', 'CIS AZURE V1.3', 'CIS DOCKER V1.2', 'CIS EKS V1.1', 'CIS GKE V1.1', 'CIS KUBERNETES V1.6'];

/**
 * Lambda Edge that connect to our cloudFront distribution, for behave: "/link/*"
 * The lambda generate HTTP redirect response with 302 status code and Location header.
 * Details about viewer-request event, here: https://docs.aws.amazon.com/lambda/latest/dg/lambda-edge.html
 * Example:
 * This url: https://www.yuda1.bridgecrew.cloud/link/badge?fullRepo=livnoni/terragoat&benchmark=HIPAA&vcs=github
 * Will redirect to:
 * https://www.yuda1.bridgecrew.cloud/incident?Open=true&ALL_SEVERITY=true&ALL_CATEGORIES=true&source_type=Repositories&tab=Errors&type=Violation&Closed=true&Suppressed=true&Remediated=true&is_custom=No&benchmarks=PCI-DSS+V3.2&accounts=livnoni%2Fterragoat
 * @param event
 * @param context
 * @param callback
 */
module.exports.handler = (event, context, callback) => {
    try {
        const { request } = event.Records[0].cf;
        console.info(`got request:\n${JSON.stringify(request)}`);

        const params = querystring.parse(request.querystring);
        const host = request.headers.host.find(h => h.key === 'Host').value; // e.g: www.yuda1.bridgecrew.cloud

        const type = request.uri.split('/').pop(); // e.g: /link/{TYPE}

        const redirectUrl = new URL(`https://${host}/incidents`);

        const response = {
            status: '302',
            statusDescription: 'Found',
            headers: {
                location: [{
                    key: 'Location',
                    value: redirectUrl.href
                }]
            }
        };

        switch (type) {
            case 'badge':
                redirectUrl.searchParams.append('Open', true);
                redirectUrl.searchParams.append('ALL_SEVERITY', true);
                redirectUrl.searchParams.append('ALL_CATEGORIES', true);
                redirectUrl.searchParams.append('source_type', 'Repositories');
                redirectUrl.searchParams.append('tab', 'Errors');
                redirectUrl.searchParams.append('type', 'Violation');
                redirectUrl.searchParams.append('is_custom', 'No');
                // todo: support general badge! need to append all the benchmarks types - one by one, we don't have 'all' flag
                if (params.benchmark) {
                    if (params.benchmark === 'INFRASTRUCTURE SECURITY') {
                        // todo: will be removed once the app will support benchmarks='all'
                        BENCHMARKS.forEach(benchmark => {
                            redirectUrl.searchParams.append('benchmarks', benchmark);
                        });
                    } else {
                        redirectUrl.searchParams.append('benchmarks', params.benchmark);
                    }
                }
                if (params.fullRepo)redirectUrl.searchParams.append('accounts', params.fullRepo);

                if (params.vcs) redirectUrl.searchParams.append('utm_source', params.vcs);
                redirectUrl.searchParams.append('utm_medium', 'badge');
                if (params.fullRepo)redirectUrl.searchParams.append('utm_campaign', params.fullRepo);

                response.headers.location.find(l => l.key === 'Location').value = redirectUrl.href;
                console.info('redirect to: ', redirectUrl.href);
                callback(null, response);
                break;
            default:
                console.warn('not found - return 404');
                callback(null, {
                    status: '404',
                    statusDescription: 'Not Found'
                });
        }
    } catch (e) {
        console.error('got error:', e);
        callback(null, {
            status: '500',
            statusDescription: 'Internal Server Error'
        });
    }
};