/*
 * Copyright (c) 2018 Liara Anna Marie Rørvig
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const native_http = require('http');
const native_url = require('url');
const { Url: URL, parse: native_parse_url } = native_url;
const { METHODS: HTTP_METHODS, STATUS_CODES: HTTP_STATUS_CODES } = native_http;
let uws_http;

try {
    uws_http = require('uws').http;
} catch (e) {
    //Ignore this error as UWS is optional
}

const SEPARATOR = '/';
const CHAR_CODES = {
    SLASH: 47,
    COLON: 58,
    ASTERIX: 42,
    QUESTION_MARK: 63,
    ZERO_WIDTH: 65279,
    TABULATION: 9,
    NEW_LINE: 10,
    FORM_FEED: 12,
    CARRIAGE_RETURN: 13,
    SPACE: 20,
    POUND: 23,
    NO_BREAK_SPACE: 160
};

const MATCH_TYPES = {
    STATIC: 'static',
    PARAMETER: 'parameter',
    ANY: 'any',
    OPTIONAL: 'optional'
};

class LilCheetah {
    constructor(options = {}) {
        const { server, error_handler } = options;
        this.options = options;
        this.server = server;
        this.middlewares = [];
        this.base_middlewares = {};
        this.routes = {};
        this.error_handler = error_handler || this.defaultErrorHandler.bind(this);
        this.all = this.addRoute.bind(this, '*');

        HTTP_METHODS.forEach((http_method) => {
            this[http_method.toLowerCase()] = this.addRoute.bind(
                this,
                http_method
            );
        });
    }

    use(path, ...handlers) {
        if (LilCheetah.isFunction(path)) {
            this.middlewares = this.middlewares.concat(path, handlers);
        } else if (path === SEPARATOR) {
            this.middlewares.push(...handlers);
        } else {
            path = LilCheetah.appendSeparator(path);
            this.base_middlewares[path] = this.base_middlewares[path] || [];

            handlers.forEach((handler) => {
                this.base_middlewares[path].push(handler);
            });
        }

        return this;
    }

    listen(port, hostname) {
        return new Promise((resolve, reject) => {
            try {
                if (!this.server) {
                    const http_lib = uws_http ? uws_http : native_http;
                    const http_options = uws_http
                        ? this.handleRequest.bind(this)
                        : undefined;

                    this.server = http_lib.createServer(http_options);
                }

                if (this.server instanceof native_http.Server) {
                    this.server.on('request', this.handleRequest.bind(this));
                }

                this.server.listen(port, hostname, (listen_error) => {
                    return listen_error ? reject(listen_error) : resolve();
                });
            } catch (e) {
                return reject(e);
            }
        });
    }

    addRoute(method, pattern, ...handlers) {
        if (!this.routes[method]) {
            this.routes[method] = [];
        }

        const parsed_pattern = LilCheetah.parseRoutePattern(pattern);
        this.routes[method].push({
            pattern: parsed_pattern,
            handlers
        });

        return this;
    }

    findRoute(method, url) {
        url = LilCheetah.clean(url);
        const method_specific_routes = this.routes[method] || [];
        const wildcard_routes = this.routes['*'] || [];
        const routes = [...method_specific_routes, ...wildcard_routes];
        const matches = LilCheetah.matchRoutePattern(url, routes);

        switch (matches.length) {
            case 0:
                return false;
            case 1:
                const match = matches[0];

                return {
                    params: LilCheetah.exec(url, match.pattern),
                    handlers: match.handlers
                };
            default:
                throw new RangeError('Multiple handler matches for ' + url);
        }
    }

    handleRequest(request, response) {
        const parsed_url = LilCheetah.parseUrl(request.url);
        const route_set = this.findRoute(request.method, parsed_url.pathname);

        if (!route_set) {
            return response.end('404');
        }

        request.path = parsed_url.pathname;
        request.query = parsed_url.query;
        request.search = parsed_url.search;

        const middlewares = this.middlewares;
        const { handlers: route_handlers } = route_set;

        if (middlewares.length === 0 && route_set.handlers.length === 1) {
            try {
                const result = handlers[0](request, response);

                if (result && LilCheetah.isFunction(result.catch)) {
                    result.catch(this.catchError.bind(this, request, response));
                }

                return;
            } catch (e) {
                return this.handleError(e, request, response);
            }

            return;
        }

        const next = (error) => {
            if (error) {
                return this.handleError(error, request, response);
            }

            loop();
        };

        const handlers = [...middlewares, ...route_handlers];
        let handlers_length = handlers.length;
        let handler_index = 0;

        const loop = () => {
            let nxt = next;

            if (handler_index === handlers_length - 1) {
                nxt = undefined;
            }

            try {
                const result = handlers[handler_index++](
                    request,
                    response,
                    nxt
                );

                if (result && LilCheetah.isFunction(result.catch)) {
                    result.catch(this.catchError.bind(this, request, response));
                }

                return;
            } catch (e) {
                return this.handleError(e, request, response);
            }
        };

        try {
            loop();
        } catch (e) {
            return this.handleError(e, request, response);
        }
    }

    catchError(request, response, error) {
        return this.handleError(error, request, response);
    }

    defaultErrorHandler(error, request, response) {
        response.end(error.message);
    }

    handleError(error, request, response) {
        if (this.error_handler) {
            return this.error_handler(error, request, response);
        }

        return this.defaultErrorHandler(error, request, response);
    }

    isUsingUWS() {
        return uws_http && this.server && !this.options.server;
    }

    static isFunction(func) {
        return func && {}.toString.call(func) === '[object Function]';
    }

    static appendSeparator(path) {
        return path.charCodeAt(0) === CHAR_CODES.SLASH
            ? path
            : SEPARATOR + path;
    }

    static parseUrl(url) {
        if (typeof url !== 'string' || url.charCodeAt(0) !== CHAR_CODES.SLASH) {
            return native_parse_url(url);
        }

        let pathname = url;
        let query;
        let search_string;

        for (let index = 0; index < url.length; index++) {
            switch (url.charCodeAt(index)) {
                case CHAR_CODES.QUESTION_MARK /* ?  */:
                    if (!search_string) {
                        pathname = url.substring(0, index);
                        query = url.substring(index + 1);
                        search_string = url.substring(index);
                    }
                    break;
                case CHAR_CODES.TABULATION:
                case CHAR_CODES.NEW_LINE:
                case CHAR_CODES.FORM_FEED:
                case CHAR_CODES.CARRIAGE_RETURN:
                case CHAR_CODES.SPACE:
                case CHAR_CODES.POUND:
                case CHAR_CODES.NO_BREAK_SPACE:
                case CHAR_CODES.ZERO_WIDTH:
                    return native_parse_url(url);
            }
        }

        const parsed_url = new URL();

        parsed_url.path = url;
        parsed_url.href = url;
        parsed_url.pathname = pathname;
        parsed_url.query = query;
        parsed_url.search = search_string;

        return parsed_url;
    }

    static parseRoutePattern(pattern) {
        const original = pattern;
        pattern = this.clean(pattern);

        if (pattern === SEPARATOR) {
            return [
                {
                    original,
                    type: MATCH_TYPES.STATIC,
                    value: pattern
                }
            ];
        }

        const result = [];

        for (
            let index = 0, pattern_length = pattern.length;
            index < pattern_length;
            index++
        ) {
            const current_char_code = pattern.charCodeAt(index);

            if (current_char_code === CHAR_CODES.COLON) {
                let type = MATCH_TYPES.PARAMETER;
                let reset_index = 0;
                const param_index = index + 1;

                while (
                    index < pattern_length &&
                    pattern.charCodeAt(index) !== CHAR_CODES.SLASH
                ) {
                    if (
                        pattern.charCodeAt(index) === CHAR_CODES.QUESTION_MARK
                    ) {
                        reset_index = index;
                        type = MATCH_TYPES.OPTIONAL;
                    }

                    index++;
                }

                result.push({
                    original,
                    type: type,
                    value: pattern.substring(
                        param_index,
                        reset_index === 0 ? index : reset_index
                    )
                });

                pattern = pattern.substring(index);
                pattern_length -= index;
                index = 0;

                continue;
            }

            if (current_char_code === CHAR_CODES.ASTERIX) {
                result.push({
                    original,
                    type: MATCH_TYPES.ANY,
                    value: pattern.substring(index)
                });

                continue;
            }

            const start_index = index;

            while (
                index < pattern_length &&
                pattern.charCodeAt(index) !== CHAR_CODES.SLASH
            ) {
                ++index;
            }

            result.push({
                original,
                type: MATCH_TYPES.STATIC,
                value: pattern.substring(start_index, index)
            });

            pattern = pattern.substring(index);
            pattern_length -= index;
            index = 0;
        }

        return result;
    }

    static matchRoutePattern(url, route_sets) {
        const cleaned_url = LilCheetah.clean(url);
        const url_pieces = LilCheetah.split(cleaned_url);
        const pieces = url_pieces.length;

        for (let index = 0; index < route_sets.length; index++) {
            const set = route_sets[index];
            const pattern = set.pattern;
            const pattern_length = pattern.length;

            const equal_length = pieces === pattern_length;
            const pattern_less_but_any =
                pattern_length < pieces &&
                pattern[pattern_length - 1].type === MATCH_TYPES.ANY;
            const pattern_more_but_optional =
                pattern_length > pieces &&
                pattern[pattern_length - 1].type === MATCH_TYPES.OPTIONAL;

            if (
                (equal_length ||
                    pattern_less_but_any ||
                    pattern_more_but_optional) &&
                LilCheetah.isFullMatch(url_pieces, pattern)
            ) {
                return [set];
            }
        }

        return [];
    }

    static isFullMatch(url_pieces, pattern) {
        for (let index = 0; index < pattern.length; index++) {
            const url_piece = url_pieces[index];
            const pattern_piece = pattern[index];

            if (!LilCheetah.isMatch(url_piece, pattern_piece)) {
                return false;
            }
        }

        return true;
    }

    static isMatch(url_piece, pattern_piece) {
        return (
            (pattern_piece.value === url_piece &&
                pattern_piece.type === MATCH_TYPES.STATIC) ||
            (url_piece === SEPARATOR
                ? pattern_piece.type === MATCH_TYPES.OPTIONAL ||
                  pattern_piece.type === MATCH_TYPES.ANY
                : pattern_piece.type !== MATCH_TYPES.STATIC)
        );
    }

    static exec(url, pattern_pieces) {
        const parameters = {};
        const url_pieces = LilCheetah.split(url);

        pattern_pieces.forEach((pattern_piece, index) => {
            const url_piece = url_pieces[index];

            if (url_piece === SEPARATOR) {
                return;
            }

            if (url_piece) {
                parameters[pattern_piece.value] = url_piece;
            }
        });

        return parameters;
    }

    static clean(str) {
        if (str === SEPARATOR) {
            return str;
        }

        while (str.charCodeAt(0) === CHAR_CODES.SLASH) {
            str = str.substring(1);
        }

        while (str.charCodeAt(str.length - 1) === CHAR_CODES.SLASH) {
            str = str.substring(0, str.length - 1);
        }

        if (str === '') {
            return SEPARATOR;
        }

        return str;
    }

    static split(str) {
        str = LilCheetah.clean(str);

        if (str === SEPARATOR) {
            return [SEPARATOR];
        }

        return str.split(SEPARATOR);
    }
}

module.exports = LilCheetah;
