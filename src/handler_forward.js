import http from 'http';
import url from 'url';
import _ from 'underscore';
import { isHopByHopHeader, tee, DEFAULT_PORT } from './tools';
import HandlerBase from './handler_base';


/**
 * Represents a proxied request to a HTTP server, either direct or chained via another proxy.
 */
export default class HandlerForward extends HandlerBase {
    constructor(options) {
        super(options);

        this.bindHandlersToThis(['onTrgResponse', 'onTrgError']);
    }

    log(str) {
        if (this.verbose) {
            const srcReq = this.srcRequest || {};
            if (!srcReq.method) console.log('WARNING: no method ???');
            console.log(`HandlerForward[${this.proxyChainUrlRedacted ? this.proxyChainUrlRedacted + ' -> ' : ''}${srcReq.method} ${srcReq.url}]: ${str}`);
        }
    }

    run() {
        this.log('Connecting...');

        const requestOptions = url.parse(this.srcRequest.url);
        requestOptions.method = this.srcRequest.method;
        requestOptions.headers = {};

        // setup outbound proxy request HTTP headers
        //TODO: var hasXForwardedFor = false;
        //var hasVia = false;
        //var via = '1.1 ' + hostname + ' (proxy/' + version + ')';

        for (let i = 0; i<this.srcRequest.rawHeaders.length; i += 2) {
            const headerName = this.srcRequest.rawHeaders[i];
            const headerValue = this.srcRequest.rawHeaders[i + 1];

            if (headerName === 'Connection' && headerValue === 'keep-alive') {
                // Keep the "Connection: keep-alive" header, to reduce the chance that the server
                // will detect we're not a browser and also to improve performance
            } else if (isHopByHopHeader(headerName)) {
                continue;
            }

            /*

            if (!hasXForwardedFor && 'x-forwarded-for' === keyLower) {
                // append to existing "X-Forwarded-For" header
                // http://en.wikipedia.org/wiki/X-Forwarded-For
                hasXForwardedFor = true;
                value += ', ' + socket.remoteAddress;
                debug.proxyRequest('appending to existing "%s" header: "%s"', key, value);
            }

            if (!hasVia && 'via' === keyLower) {
                // append to existing "Via" header
                hasVia = true;
                value += ', ' + via;
                debug.proxyRequest('appending to existing "%s" header: "%s"', key, value);
            }
            */

            requestOptions.headers[headerName] = headerValue;
        };

        /*
        // add "X-Forwarded-For" header if it's still not here by now
        // http://en.wikipedia.org/wiki/X-Forwarded-For
        if (!hasXForwardedFor) {
            headers['X-Forwarded-For'] = socket.remoteAddress;
            debug.proxyRequest('adding new "X-Forwarded-For" header: "%s"', headers['X-Forwarded-For']);
        }

        // add "Via" header if still not set by now
        if (!hasVia) {
            headers.Via = via;
            debug.proxyRequest('adding new "Via" header: "%s"', headers.Via);
        }

        // custom `http.Agent` support, set `server.agent`
        var agent = server.agent;
        if (null != agent) {
            debug.proxyRequest('setting custom `http.Agent` option for proxy request: %s', agent);
            parsed.agent = agent;
            agent = null;
        }
         */


        if (!requestOptions.port) requestOptions.port = DEFAULT_PORT;


        // If desired, send the request via proxy
        if (this.proxyChainUrlParsed) {
            requestOptions.hostname = requestOptions.host = this.proxyChainUrlParsed.hostname;
            requestOptions.port = this.proxyChainUrlParsed.port;

            // HTTP requests to proxy contain the full URL in path, for example:
            // "GET http://www.example.com HTTP/1.1\r\n"
            // So we need to replicate it here
            requestOptions.path = this.srcRequest.url;

            this.maybeAddProxyAuthorizationHeader(requestOptions.headers);
        }

        if (requestOptions.protocol !== 'http:') {
            // only "http://" is supported, "https://" should use CONNECT method
            this.fail(`Only HTTP protocol is supported (was ${requestOptions.protocol})`, 400);
            return;
        }

        this.log('Connecting...');

        //console.dir(requestOptions);

        this.trgRequest = http.request(requestOptions);
        this.trgRequest.on('response', this.onTrgResponse);
        this.trgRequest.on('error', this.onTrgError);

        //this.srcRequest.pipe(tee('to trg')).pipe(this.trgRequest);
        this.srcRequest.pipe(this.trgRequest);
    }

    onTrgResponse(response) {
        this.log(`Received response from target (${response.statusCode})`);

        this.srcGotResponse = true;

        // Prepare response headers
        var headers = {};
        for (let i = 0; i<response.rawHeaders.length; i += 2) {
            const headerName = response.rawHeaders[i];
            const headerValue = response.rawHeaders[i + 1];

            if (isHopByHopHeader(headerName)) continue;

            headers[headerName] = headerValue;
        }

        this.srcResponse.writeHead(response.statusCode, headers);
        response.pipe(this.srcResponse);
    };


    onTrgError(err) {
        this.log(`Target socket failed: ${err.stack || err}`);
        this.fail(err);
    };

    removeListeners() {
        super.removeListeners();

        if (this.trgRequest) {
            this.trgRequest.on('response', this.onTrgResponse);
            this.trgRequest.on('error', this.onTrgError);
        }
    }
}
