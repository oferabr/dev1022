// eslint-disable-next-line max-len
const base64Icon = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABEAAAAOCAYAAADJ7fe0AAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAAyZpVFh0WE1MOmNvbS5hZG9iZS54bXAAAAAAADw/eHBhY2tldCBiZWdpbj0i77u/IiBpZD0iVzVNME1wQ2VoaUh6cmVTek5UY3prYzlkIj8+IDx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iIHg6eG1wdGs9IkFkb2JlIFhNUCBDb3JlIDUuNi1jMTQ1IDc5LjE2MzQ5OSwgMjAxOC8wOC8xMy0xNjo0MDoyMiAgICAgICAgIj4gPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4gPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6eG1wPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvIiB4bWxuczp4bXBNTT0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wL21tLyIgeG1sbnM6c3RSZWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9zVHlwZS9SZXNvdXJjZVJlZiMiIHhtcDpDcmVhdG9yVG9vbD0iQWRvYmUgUGhvdG9zaG9wIENDIDIwMTkgKFdpbmRvd3MpIiB4bXBNTTpJbnN0YW5jZUlEPSJ4bXAuaWlkOjI0MTlGN0Q2MEVEQjExRUJCQzI5RUM2QzJBRkY2Qjc5IiB4bXBNTTpEb2N1bWVudElEPSJ4bXAuZGlkOjI0MTlGN0Q3MEVEQjExRUJCQzI5RUM2QzJBRkY2Qjc5Ij4gPHhtcE1NOkRlcml2ZWRGcm9tIHN0UmVmOmluc3RhbmNlSUQ9InhtcC5paWQ6MjQxOUY3RDQwRURCMTFFQkJDMjlFQzZDMkFGRjZCNzkiIHN0UmVmOmRvY3VtZW50SUQ9InhtcC5kaWQ6MjQxOUY3RDUwRURCMTFFQkJDMjlFQzZDMkFGRjZCNzkiLz4gPC9yZGY6RGVzY3JpcHRpb24+IDwvcmRmOlJERj4gPC94OnhtcG1ldGE+IDw/eHBhY2tldCBlbmQ9InIiPz4pPFjOAAAC2UlEQVR42mxTWUhUYRT+/nvvLDozauO4ZJooE0yNCQolbagRmGlaWLRQkVSE2UMPaYEPkVFKtNBzBUIRY70UhJmi9BDkk7lMNlgj1kupjc64zXK3zr1DkuAP5/7nX853vvPd8zODq/UUgHtkBrIBsmeiMvcy0+BWTpvPJYVFtESBKAMe0FkQawxGICLNgrYQJQU8x6AIkUmrnOKpQv3BPFuaWyWEBRFTMRlljMG3FojEOMYrsgppah5IMsOYlojYz0VgBsi3u7A5pRj5yW5YBARmo9igxpmtDJ53lJ+UlmKOBIsRXS/qEYrGMNbnB1uy0bGCueXv+DY3iPHQKATekbjR6tgTldHxPxOObFQlnoLAYd+ufKSkJABLP6CK04QhgTPn0BUjguHP6J5oQZ93pNRhwV3GVoN4QTrIsoJAMIzKXU7097fB47kIe1oSlIgPWwrz8L63HV3dzdh2JILAHzQpMo78D6ILJUkqYqKE4wcKkJ5hRXWNC0ODjaip3Ykvw41wuezIcWbi/NHtmA4AqopXFJb/D+SrtiOYeKxPs6Gt7SMK3FdgTWzW2b15fQE9vX7k5tRhq/MtOq6ryNhAYur/Ex+01ogz4bmFaDim7074tVYIk01jcjKk730a+kbfChwyXUJghoEZV+TQBHuk4cV4m2lM9M2UPOscweMn1UhPl+Eu3ISy0o249bALN5r2osS+H2ZKGVwGOu8AVjuVwelADTop3sjGFWtSyZnjzxFZPIbbd2oRnA9hR8V9DPRkoVg2o+pqPPW7p6AyyVFX2ASYYXOrpsw19RffLs0ux0vheboZJK6HcaKoEt8ngHWkA6PMc7+BVM2HLu4QTWcFbcVUeMRwrJ3jEqAoIT3V7swGlOcWgToUqblU8zKmKMiXmgUvhXjJH9bkgv5mFOopQf1hs1suL/5euJlqcRrKsut+upKzx2Yi8NJr0IJ8pkT4Nf0QZ7Bq/BVgANb8EvhDLTshAAAAAElFTkSuQmCC';

// It's hard coded for better performance (Reduce the calculation time of the lambda to a minimum)
const NABadge = `<svg width="166.5" height="20" viewBox="0 0 1665 200" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" role="img" aria-label="Infrastructure Tests: N/A">
  <title>Infrastructure Tests: N/A</title>
  <linearGradient id="a" x2="0" y2="100%">
    <stop offset="0" stop-opacity=".1" stop-color="#EEE"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <mask id="m"><rect width="1665" height="200" rx="30" fill="#FFF"/></mask>
  <g mask="url(#m)">
    <rect width="1358" height="200" fill="#5B5B5B"/>
    <rect width="307" height="200" fill="#B0ADAD" x="1358"/>
    <rect width="1665" height="200" fill="url(#a)"/>
  </g>
  <g aria-hidden="true" fill="#fff" text-anchor="start" font-family="Verdana,DejaVu Sans,sans-serif" font-size="110">
    <text x="220" y="148" textLength="1098" fill="#000" opacity="0.25">Infrastructure Tests</text>
    <text x="210" y="138" textLength="1098">Infrastructure Tests</text>
    <text x="1413" y="148" textLength="207" fill="#000" opacity="0.25">N/A</text>
    <text x="1403" y="138" textLength="207">N/A</text>
  </g>
  <image x="40" y="35" width="130" height="130" xlink:href="${base64Icon}"/>
</svg>`;

/**
 * This function updates the response status to 200 if the request status that got from the origin (s3) - is 403
 * body content to return to the viewer with the N/A badge
 */

module.exports.handler = (event, context, callback) => {
    const { response } = event.Records[0].cf;

    console.info(`got request2:\n${JSON.stringify(response)}`);

    if (response.status == 403) {
        console.info('response status is 403');
        response.status = 200;
        response.statusDescription = 'OK';
        response.body = NABadge;
        response.headers['cache-control'] = [{
            key: 'Cache-Control',
            value: 'no-cache'
        }, {
            key: 'Cache-Control',
            value: 'no-store'
        }, {
            key: 'Cache-Control',
            value: 'must-revalidate'
        }];
        response.headers['content-type'] = [{
            key: 'Content-Type',
            value: 'image/svg+xml'
        }];
    }

    console.info('response after changing=\n', JSON.stringify(response));

    callback(null, response);
};