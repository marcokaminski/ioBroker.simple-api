/* jshint -W097 */
/* jshint strict:false */
/*jslint node: true */
/*jshint -W061 */
'use strict';

/**
 * SimpleAPI class
 *
 * From settings used only secure, auth and crossDomain
 *
 * @class
 * @param {object} server http or https node.js object
 * @param {object} webSettings settings of the web server, like <pre><code>{secure: settings.secure, port: settings.port}</code></pre>
 * @param {object} adapter web adapter object
 * @param {object} instanceSettings instance object with common and native
 * @param {object} app express application
 * @return {object} object instance
 */
function SimpleAPI(server, webSettings, adapter, instanceSettings, app) {
    if (!(this instanceof SimpleAPI)) return new SimpleAPI(server, webSettings, adapter, instanceSettings, app);

    //this.server    = server;
    this.app = app;
    this.adapter = adapter;
    this.settings = webSettings;
    this.config = instanceSettings ? instanceSettings.native : {};
    this.namespace = instanceSettings ? instanceSettings._id.substring('system.adapter.'.length) : 'simple-api';

    this.restApiDelayed = {
        timer: null,
        responseType: '',
        response: null,
        waitId: 0
    };

    const that = this;
    // Cache
    this.users = {};

    // static information
    const commandsPermissions = {
        getPlainValue: {type: 'state', operation: 'read'},
        get: {type: 'state', operation: 'read'},
        getBulk: {type: 'state', operation: 'read'},
        set: {type: 'state', operation: 'write'},
        toggle: {type: 'state', operation: 'write'},
        setBulk: {type: 'state', operation: 'write'},
        setValueFromBody: {type: 'state', operation: 'write'},
        getObjects: {type: 'object', operation: 'list'},
        objects: {type: 'object', operation: 'list'},
        states: {type: 'state', operation: 'list'},
        getStates: {type: 'state', operation: 'list'},
        search: {type: 'state', operation: 'list'},
        query: {type: 'state', operation: 'read'},
        annotations: {type: '', operation: ''},
        help: {type: '', operation: ''}
    };

    const __construct = (function () {
        that.adapter.log.info((that.settings.secure ? 'Secure ' : '') + 'simpleAPI server listening on port ' + that.settings.port);
        that.adapter.config.defaultUser = that.adapter.config.defaultUser || 'system.user.admin';
        if (!that.adapter.config.defaultUser.match(/^system\.user\./)) {
            that.adapter.config.defaultUser = 'system.user.' + that.adapter.config.defaultUser;
        }
        if (that.adapter.config.onlyAllowWhenUserIsOwner === undefined) that.adapter.config.onlyAllowWhenUserIsOwner = false;
        adapter.log.info('Allow states only when user is owner: ' + that.adapter.config.onlyAllowWhenUserIsOwner);

        if (that.app) {
            adapter.log.info('Install extension on /' + that.namespace + '/');
            that.app.use('/' + that.namespace + '/', (req, res, next) => that.restApi.call(that, req, res));

            // let it be accessible under old address too
            for (const c in commandsPermissions) {
                (function (command) {
                    adapter.log.info('Install extension on /' + command + '/');
                    that.app.use('/' + command + '/', (req, res, next) => {
                        req.url = '/' + command + req.url;
                        that.restApi.call(that, req, res);
                    });
                })(c);
            }
        }
        // Subscribe on user changes to manage the permissions cache
        that.adapter.subscribeForeignObjects('system.group.*');
        that.adapter.subscribeForeignObjects('system.user.*');
    }.bind(this))();

    this.isAuthenticated = function (values, callback) {
        if (!values.user || !values.pass) {
            that.adapter.log.warn('No password or username!');
            callback(false);
        } else {
            that.adapter.checkPassword(values.user, values.pass, res => {
                if (res) {
                    that.adapter.log.debug('Logged in: ' + values.user);
                    callback(true);
                } else {
                    that.adapter.log.warn('Invalid password or user name: ' + values.user);
                    callback(false);
                }
            });
        }
    };

    this.stateChange = function (id, state) {
        if (that.restApiDelayed.id === id && state && state.ack) {
            adapter.unsubscribeForeignStates(id);
            that.restApiDelayed.response = state;
            setTimeout(restApiDelayedAnswer, 0);
        }
    };

    this.userReg = new RegExp('^system\.user\.');
    this.groupReg = new RegExp('^system\.group\.');

    // if user politics changes, clear cache
    this.objectChange = function (id, state) {
        if (this.userReg.test(id) || this.groupReg.test(id)) {
            this.users = {};
        }
    };

    function restApiPost(req, res, command, oId, values) {
        const responseType = 'json';
        let status = 500;
        const headers = {'Access-Control-Allow-Origin': '*'};

        let body = '';
        req.on('data', data => body += data);
        req.on('end', () => {
            switch (command) {
                case 'setBulk':
                    that.adapter.log.debug('POST-' + command + ': body = ' + body);
                    let arr = [];
                    if (body) {
                        arr = body.split('&');
                    }

                    for (let i = 0; i < arr.length; i++) {
                        arr[i] = arr[i].split('=');
                        try {
                            values[arr[i][0].trim()] = (arr[i][1] === undefined) ? null : decodeURIComponent((arr[i][1] + '').replace(/\+/g, '%20'));
                        }
                        catch (e) {
                            values[arr[i][0].trim()] = arr[i][1];
                        }
                    }

                    if (values.prettyPrint !== undefined) {
                        if (values.prettyPrint === 'false') values.prettyPrint = false;
                        if (values.prettyPrint === null) values.prettyPrint = true;
                    }

                    let cnt = 0;
                    let response = [];
                    that.adapter.log.debug('POST-' + command + ': values = ' + JSON.stringify(values));
                    for (const _id in values) {
                        if (!values.hasOwnProperty(_id) || _id === 'prettyPrint' || _id === 'user' || _id === 'pass') continue;
                        cnt++;
                        that.adapter.log.debug('"' + _id + '"');
                        findState(_id, values.user, (err, id, originId) => {
                            if (err) {
                                status = 500;
                                if (err.indexOf('permissionError') !== -1) {
                                    status = 401;
                                }
                                doResponse(res, 'plain', status, headers, 'error: ' + err, values.prettyPrint);
                                cnt = 0;
                            } else if (!id) {
                                response.push({error: 'error: datapoint "' + originId + '" not found'});
                                if (!--cnt) doResponse(res, responseType, status, headers, response, values.prettyPrint);
                            } else {
                                const usedId = (values[originId] ? originId : id);
                                that.adapter.log.debug('POST-' + command + ' for id=' + id + ', oid=' + originId + ', used=' + usedId + ', value=' + values[usedId]);
                                if (values[usedId] === 'true') {
                                    values[usedId] = true;
                                } else if (values[usedId] === 'false') {
                                    values[usedId] = false;
                                } else if (!isNaN(values[usedId]) && values[usedId] == parseFloat(values[usedId])) {
                                    values[usedId] = parseFloat(values[usedId]);
                                }

                                adapter.setForeignState(id, values[usedId], false, {
                                    user: values.user,
                                    limitToOwnerRights: that.adapter.config.onlyAllowWhenUserIsOwner
                                }, (err, id) => {
                                    if (err) {
                                        status = 500;
                                        if (err.indexOf('permissionError') !== -1) {
                                            status = 401;
                                        }
                                        doResponse(res, 'plain', status, headers, 'error: ' + err, values.prettyPrint);
                                        cnt = 0;
                                    } else {
                                        adapter.log.debug('Add to Response: ' + JSON.stringify({
                                            id: id,
                                            val: values[usedId]
                                        }));
                                        response.push({id: id, val: values[usedId]});
                                        if (!--cnt) {
                                            status = 200;
                                            doResponse(res, responseType, status, headers, response, values.prettyPrint);
                                        }
                                    }
                                });
                            }
                        });
                    }
                    if (!cnt) doResponse(res, responseType, status, headers, response, values.prettyPrint);
                    break;

                case 'setValueFromBody': {
                    //that.adapter.log.debug('POST-' + command + ': body = ' + JSON.stringify(body));					// "{0123456xx}"
                    //that.adapter.log.debug('POST-' + command + ': req.url = ' + JSON.stringify(req.url));		// "/setValueFromBody?javascript.0.Nuki.Devices.NukiSL1.NukiBridgeResponse&prettyPrint"
                    //that.adapter.log.debug('POST-' + command + ': valuesAA = ' + JSON.stringify(values));		// {"javascript.0.Nuki.Devices.NukiSL1.NukiBridgeResponse":null,"prettyPrint":true,"user":"system.user.admin"}

                    for (const _id2 in oId) {
                        if (oId.hasOwnProperty(_id2)) {
                            values[oId[_id2]] = body;
                        }
                    }

                    if (values.prettyPrint !== undefined) {
                        if (values.prettyPrint === 'false') values.prettyPrint = false;
                        if (values.prettyPrint === null) values.prettyPrint = true;
                    }

                    if (!oId.length || !oId[0]) {
                        doResponse(res, responseType, status, headers, {error: 'no object/datapoint given'}, values.prettyPrint);
                        break;
                    }


                    let response = [];
                    that.adapter.log.debug('POST-' + command + ': values = ' + JSON.stringify(values));
                    let cnt = oId.length;
                    for (let k = 0; k < oId.length; k++) {
                        that.adapter.log.debug('"' + oId[k] + '"');
                        findState(oId[k], values.user, (err, id, originId) => {
                            if (err) {
                                status = 500;
                                if (err.indexOf('permissionError') !== -1) {
                                    status = 401;
                                }
                                doResponse(res, 'plain', status, headers, 'error: ' + err, values.prettyPrint);
                                cnt = 0;
                            } else if (!id) {
                                response.push({error: 'error: datapoint "' + originId + '" not found'});
                                if (!--cnt) doResponse(res, responseType, status, headers, response, values.prettyPrint);
                            } else {
                                const usedId = (values[originId] ? originId : id);
                                that.adapter.log.debug('POST-' + command + ' for id=' + id + ', oid=' + originId + ', used=' + usedId + ', value=' + values[usedId]);
                                if (values[usedId] === 'true') {
                                    values[usedId] = true;
                                } else if (values[usedId] === 'false') {
                                    values[usedId] = false;
                                } else if (!isNaN(values[usedId]) && values[usedId] == parseFloat(values[usedId])) {
                                    values[usedId] = parseFloat(values[usedId]);
                                }

                                adapter.setForeignState(id, values[usedId], false, {
                                    user: values.user,
                                    limitToOwnerRights: that.adapter.config.onlyAllowWhenUserIsOwner
                                }, (err, id) => {
                                    if (err) {
                                        status = 500;
                                        if (err.indexOf('permissionError') !== -1) {
                                            status = 401;
                                        }
                                        doResponse(res, 'plain', status, headers, 'error: ' + err, values.prettyPrint);
                                        cnt = 0;
                                    } else {
                                        status = 200;
                                        adapter.log.debug('Add to Response: ' + JSON.stringify({
                                            id: id,
                                            val: values[usedId]
                                        }));
                                        response.push({id: id, val: values[usedId]});
                                        if (!--cnt) doResponse(res, responseType, status, headers, response, values.prettyPrint);
                                    }
                                });
                            }
                        });
                    }
                    if (!cnt) doResponse(res, responseType, status, headers, response, values.prettyPrint);
                }
                    break;

                case 'search':
                    if (adapter.config.dataSource && adapter.config.allDatapoints !== true) {
                        adapter.sendTo(adapter.config.dataSource, 'getEnabledDPs', {}, function (result) {
                            status = 200;
                            oId = [];
                            for (var id in result) {
                                if( result.hasOwnProperty(id) ) {
                                    oId.push(id);
                                }                                 
                            }
                            doResponse(res, responseType, status, headers, oId, values.prettyPrint);
                        });
                    } else {
                        var target = JSON.parse(body).target || "";
                        that.adapter.log.debug("[SEARCH] target = " + target);

                        adapter.getForeignStates(values.pattern || target + '*', {
                            user: values.user,
                            limitToOwnerRights: that.adapter.config.onlyAllowWhenUserIsOwner
                        }, (err, list) => {
                            if (err) {
                                status = 500;
                                if (err.indexOf('permissionError') !== -1) {
                                    status = 401;
                                }
                                doResponse(res, responseType, status, headers, {error: JSON.stringify(err)}, values.prettyPrint);
                            } else {
                                status = 200;
                                oId = [];
                                for (var id in list) {
                                    if( list.hasOwnProperty(id) ) {
                                        oId.push(id);
                                    }                                 
                                }
                                doResponse(res, responseType, status, headers, oId, values.prettyPrint);
                            }
                        });
                    }
                    break;

                case 'query':
                    var targets = JSON.parse(body).targets || [];
                    var range  = JSON.parse(body).range || {};
                    let dateFrom = Date.now();
                    let dateTo = Date.now();

                    that.adapter.log.debug("[QUERY] targets = " + JSON.stringify(targets));
                    that.adapter.log.debug("[QUERY] range = " + JSON.stringify(range));

                    if (range) {
                        dateFrom = Date.parse(range.from);
                        dateTo = Date.parse(range.to);
                    }
                    
                    oId = [];
                    targets.forEach(t => {
                        oId.push(t.target);
                    });

                    if (!oId.length || !oId[0]) {
                        doResponse(res, responseType, status, headers, {error: 'no datapoints given'}, values.prettyPrint);
                        break;
                    }
                    let bcnt = targets.length;
                    var list = [];
                    for (let b = 0; b < targets.length; b++) {
                        if (that.adapter.config.dataSource && !(targets[b].data && targets[b].data.noHistory === true)) {
                            that.adapter.log.debug("Read data from: " + that.adapter.config.dataSource);

                            that.adapter.sendTo(that.adapter.config.dataSource, 'getHistory', {
                                id: targets[b].target,
                                options: {
                                    start:      dateFrom,
                                    end:        dateTo,
                                    aggregate: 'onchange'
                                }
                            }, function (result, step, error) {
                                if (!error) status = 200;

                                that.adapter.log.debug("[QUERY] sendTo result = " + JSON.stringify(result));

                                var element = {};
                                element.target = targets[b].target;
                                element.datapoints = [];

                                for (var i = 0; i < result.result.length; i++) {
                                    var datapoint = [result.result[i].val, result.result[i].ts];
                                    element.datapoints.push(datapoint);
                                }

                                list.push(element);

                                if (!--bcnt) {
                                    that.adapter.log.debug("[QUERY] list = " + JSON.stringify(list));
                                    doResponse(res, responseType, status, headers, list, values.prettyPrint);
                                }
                            });
                        } else {
                            that.adapter.log.debug("Read last state");

                            getState(targets[b].target, values.user, (err, state, id) => {
                                var element = {};
                                element.target = id;
                                element.datapoints = [];

                                if (err) {
                                    bcnt = 0;
                                    status = 500;
                                    if (err.indexOf('permissionError') !== -1) {
                                        status = 401;
                                    }
                                    doResponse(res, responseType, status, headers, 'error: ' + err, values.prettyPrint);
                                } else {
                                    if (id) status = 200;
                                    state = state || {};

                                    element.datapoints = [[state.val, state.ts]];

                                    list.push(element);

                                    if (!--bcnt) {
                                        that.adapter.log.debug("[QUERY] list = " + JSON.stringify(list));
                                        doResponse(res, responseType, status, headers, list, values.prettyPrint);
                                    }
                                }
                            });
                        }
                    }
                    if (!bcnt) {
                        that.adapter.log.debug("[QUERY] !bcnt");
                        doResponse(res, responseType, status, headers, list, values.prettyPrint);
                    }
                    break;
                
                case 'annotations':
                    // iobroker does not support annontations
                    that.adapter.log.debug("[ANNOTATIONS]");
                    doResponse(res, responseType, 200, headers, [], values.prettyPrint);
                    break;

                default:
                    doResponse(res, responseType, status, headers, {error: 'command ' + command + ' unknown'}, values.prettyPrint);
                    break;
            }
        });
    }

    function restApiDelayedAnswer() {
        if (that.restApiDelayed.timer) {
            clearTimeout(that.restApiDelayed.timer);
            that.restApiDelayed.timer = null;

            doResponse(that.restApiDelayed.res, that.restApiDelayed.responseType, 200, {'Access-Control-Allow-Origin': '*'}, that.restApiDelayed.response, that.restApiDelayed.prettyPrint);
            that.restApiDelayed.id = null;
            that.restApiDelayed.res = null;
            that.restApiDelayed.response = null;
            that.restApiDelayed.prettyPrint = false;
        }
    }

    function findState(idOrName, user, type, callback) {
        if (typeof type === 'function') {
            callback = type;
            type = null;
        }
        adapter.findForeignObject(idOrName, type, {user: user, checked: true}, callback);
    }

    function getState(idOrName, user, type, callback) {
        if (typeof type === 'function') {
            callback = type;
            type = null;
        }
        findState(idOrName, user, type, (err, id, originId) => {
            if (err) {
                callback && callback(err, undefined, null, originId);
            } else if (id) {
                that.adapter.getForeignState(id, {
                    user: user,
                    limitToOwnerRights: that.adapter.config.onlyAllowWhenUserIsOwner
                }, (err, obj) => {
                    if (err || !obj) {
                        obj = undefined;
                    }
                    callback && callback(err, obj, id, originId);
                });
            } else {
                callback && callback(null, undefined, null, originId);
            }
        });
    }

    function doResponse(res, type, status, _headers, content, pretty) {
        //if (!headers) headers = {};

        status = parseInt(status, 10) || 200;

        if (pretty && typeof content === 'object') {
            type = 'plain';
            content = JSON.stringify(content, null, 2);
        }

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');

        switch (type) {
            case 'json':
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.statusCode = status;
                res.end(JSON.stringify(content), 'utf8');
                break;

            case 'plain':
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.statusCode = status;
                if (typeof content === 'object') {
                    content = JSON.stringify(content);
                }

                res.end(content, 'utf8');
                break;
        }
    }

    this.commands = [];
    for (const c in commandsPermissions) {
        this.commands.push(c);
    }
    // Register api by express
    this.checkRequest = function (url) {
        const parts = url.split('/', 2);
        return (parts[1] && this.commands.indexOf(parts[1]) !== -1);
    };

    this.checkPermissions = function (user, command, callback) {
        adapter.calculatePermissions(user, commandsPermissions, acl => {
            if (user !== 'system.user.admin') {
                // type: file, object, state, other
                // operation: create, read, write, list, delete, sendto, execute, sendto
                if (commandsPermissions[command]) {
                    // If permission required
                    if (commandsPermissions[command].type) {
                        if (acl[commandsPermissions[command].type] &&
                            acl[commandsPermissions[command].type][commandsPermissions[command].operation]) {
                            return callback(null);
                        }
                    } else {
                        return callback(null);
                    }
                }

                that.adapter.log.warn('No permission for "' + user + '" to call ' + command);

                if (callback) callback('permissionError');
            } else {
                return callback(null);
            }
        });
    };

    this.restApi = function (req, res, isAuth, isChecked) {
        const values = {};
        let oId = [];
        let wait = 0;
        let responseType = 'json';
        let status = 500;
        const headers = {'Access-Control-Allow-Origin': '*'};
        let response;

        let url;
        try {
            url = decodeURI(req.url);
        }
        catch (e) {
            url = req.url;
            that.adapter.log.warn('Malformed URL encoding: ' + e);
        }
        const pos = url.indexOf('?');
        if (pos !== -1) {
            const arr = url.substring(pos + 1).split('&');
            url = url.substring(0, pos);

            for (let i = 0; i < arr.length; i++) {
                const _parts = arr[i].split('=');
                //that.adapter.log.debug('Try Decode ' + i + ': ' + arr[i][1]);
                try {
                    _parts[0] = decodeURIComponent(_parts[0]).trim().replace(/%23/g, '#');
                    _parts[1] = _parts[1] === undefined ? null : decodeURIComponent((_parts[1] + '').replace(/\+/g, '%20'));
                    values[_parts[0]] = _parts[1];
                } catch (e) {
                    values[_parts[0]] = _parts[1];
                }
                //that.adapter.log.debug('    Decode Result ' + i + ': ' + values[arr[i][0].trim()]);
            }
            if (values.prettyPrint !== undefined) {
                if (values.prettyPrint === 'false') values.prettyPrint = false;
                if (values.prettyPrint === null) values.prettyPrint = true;
            }
            // Default value for wait
            if (values.wait === null) {
                values.wait = 2000;
            }
        }

        const parts = url.split('/');
        const command = parts[1];

        // Analyse system.adapter.socketio.0.uptime,system.adapter.history.0.memRss?value=78&wait=300
        if (parts[2]) {
            oId = parts[2].split(',');
            for (let j = oId.length - 1; j >= 0; j--) {
                oId[j] = oId[j].trim().replace(/%23/g, '#');
                if (!oId[j]) oId.splice(j, 1);
            }
        }

        // If authentication check is required
        if (that.settings.auth) {
            if (!isAuth) {
                this.isAuthenticated(values, isAuth => {
                    if (isAuth) {
                        that.restApi(req, res, true);
                    } else {
                        doResponse(res, 'plain', 401, headers, 'error: authentication failed. Please write "http' + (that.settings.secure ? 's' : '') + '://' + req.headers.host + '?user=UserName&pass=Password"');
                    }
                });
                return;
            } else if (!isChecked) {
                if (!values.user.match(/^system\.user\./)) values.user = 'system.user.' + values.user;
                that.checkPermissions(values.user, command, err => {
                    if (!err) {
                        that.restApi(req, res, true, true);
                    } else {
                        doResponse(res, 'plain', 401, headers, 'error: ' + err, values.prettyPrint);
                    }
                });
                return;
            }
        } else {
            req.user = req.user || that.adapter.config.defaultUser;
            values.user = req.user;
            if (!values.user.match(/^system\.user\./)) values.user = 'system.user.' + values.user;
            if (!isChecked && command) {
                that.checkPermissions(req.user || that.adapter.config.defaultUser, command, err => {
                    if (!err) {
                        that.restApi(req, res, true, true);
                    } else {
                        doResponse(res, 'plain', 401, headers, 'error: ' + err, values.prettyPrint);
                    }
                });
                return;
            }
        }
        if (!values.user.match(/^system\.user\./)) values.user = 'system.user.' + values.user;

        if (req.method === 'POST') {
            restApiPost(req, res, command, oId, values);
            return;
        }

        switch (command) {
            case 'getPlainValue':
                responseType = 'plain';
                if (!oId.length || !oId[0]) {
                    doResponse(res, 'plain', status, headers, 'error: no datapoint given', values.prettyPrint);
                    break;
                }

                let pcnt = oId.length;
                response = '';
                for (let g = 0; g < oId.length; g++) {
                    getState(oId[g], values.user, (err, obj, id, originId) => {
                        if (err) {
                            status = 500;
                            response = 'error: ' + err;
                            if (err.indexOf('permissionError') !== -1) {
                                status = 401;
                            }
                            pcnt = 1;
                        } else if ((!id && originId) || obj === undefined) {
                            response += (response ? '\n' : '') + 'error: datapoint "' + originId + '" not found';
                        } else {
                            response += (response ? '\n' : '') + JSON.stringify(obj.val);
                            status = 200;
                        }
                        if (!--pcnt) {
                            doResponse(res, (status === 500 ? 'plain' : responseType), status, headers, response, values.prettyPrint);
                        }
                    });
                }
                break;

            case 'get':
                if (!oId.length || !oId[0]) {
                    doResponse(res, responseType, status, headers, {error: 'no object/datapoint given'}, values.prettyPrint);
                    break;
                }

                let gCnt = oId.length;
                for (let k = 0; k < oId.length; k++) {
                    that.adapter.log.debug('work for ID ' + oId[k]);
                    getState(oId[k], values.user, (err, state, id, originId) => {
                        that.adapter.log.debug('return err ' + err);
                        that.adapter.log.debug('return state ' + state);
                        that.adapter.log.debug('return id ' + JSON.stringify(id));
                        that.adapter.log.debug('return originId' + originId);
                        if (err) {
                            gCnt = 0;
                            status = 500;
                            if (err.indexOf('permissionError') !== -1) {
                                status = 401;
                            }
                            doResponse(res, 'plain', status, headers, 'error: ' + err, values.prettyPrint);
                        } else if (!id && originId) {
                            if (!response || obj === undefined) {
                                response = 'error: datapoint "' + originId + '" not found';
                            } else {
                                if (typeof response !== 'object' || response.constructor !== Array) {
                                    response = [response];
                                }
                                response.push('error: datapoint "' + originId + '" not found');
                            }
                            if (!--gCnt) {
                                doResponse(res, responseType, status, headers, response, values.prettyPrint);
                            }
                        } else {
                            const vObj = state || {};
                            status = 200;
                            that.adapter.getForeignObject(id, (err, obj) => {
                                if (obj) {
                                    for (const attr in obj) {
                                        if (obj.hasOwnProperty(attr)) {
                                            vObj[attr] = obj[attr];
                                        }
                                    }
                                }

                                if (!response) {
                                    response = vObj;
                                } else {
                                    if (typeof response !== 'object' || response.constructor !== Array) response = [response];
                                    response.push(vObj);
                                }

                                if (!--gCnt) {
                                    doResponse(res, responseType, status, headers, response, values.prettyPrint);
                                }
                            });
                        }
                    });
                }
                break;

            case 'getBulk':
                if (!oId.length || !oId[0]) {
                    doResponse(res, responseType, status, headers, {error: 'no datapoints given'}, values.prettyPrint);
                    break;
                }
                let bcnt = oId.length;
                response = [];
                for (let b = 0; b < oId.length; b++) {
                    getState(oId[b], values.user, (err, state, id, originId) => {
                        if (err) {
                            bcnt = 0;
                            status = 500;
                            if (err.indexOf('permissionError') !== -1) {
                                status = 401;
                            }
                            doResponse(res, responseType, status, headers, 'error: ' + err, values.prettyPrint);
                        } else {
                            if (id) status = 200;
                            state = state || {};
                            response.push({val: state.val, ts: state.ts});
                            if (!--bcnt) {
                                doResponse(res, responseType, status, headers, response, values.prettyPrint);
                            }
                        }
                    });
                }
                if (!bcnt) {
                    doResponse(res, responseType, status, headers, response, values.prettyPrint);
                }
                break;

            case 'set':
                if (!oId.length || !oId[0]) {
                    doResponse(res, responseType, status, headers, {error: 'object/datapoint not given'}, values.prettyPrint);
                    break;
                }
                if (values.value === undefined && values.val === undefined) {
                    doResponse(res, responseType, status, headers, `error: no value found for "${oId[0]}". Use /set/id?value=1 or /set/id?value=1&wait=1000`, values.prettyPrint);
                } else {
                    findState(oId[0], values.user, (err, id, originId) => {
                        if (err) {
                            wait = 0;
                            status = 500;
                            if (err.indexOf('permissionError') !== -1) {
                                status = 401;
                            }
                            doResponse(res, 'plain', status, headers, 'error: ' + err);
                        } else if (id) {
                            wait = values.wait || 0;
                            if (wait) wait = parseInt(wait, 10);
                            if (values.val === undefined) values.val = values.value;

                            if (values.val === 'true') {
                                values.val = true;
                            } else if (values.val === 'false') {
                                values.val = false;
                            } else if (!isNaN(values.val)) {
                                values.val = parseFloat(values.val);
                            }

                            if (wait) adapter.subscribeForeignStates(id);

                            adapter.setForeignState(id, values.val, false, {
                                user: values.user,
                                limitToOwnerRights: that.adapter.config.onlyAllowWhenUserIsOwner
                            }, err => {
                                if (err) {
                                    status = 500;
                                    if (err.indexOf('permissionError') !== -1) {
                                        status = 401;
                                    }
                                    doResponse(res, 'plain', status, headers, 'error: ' + err, values.prettyPrint);
                                    wait = 0;
                                } else if (!wait) {
                                    status = 200;
                                    response = {id: id, value: values.val, val: values.val};
                                    doResponse(res, responseType, status, headers, response, values.prettyPrint);
                                }
                            });

                            if (wait) {
                                that.restApiDelayed.responseType = responseType;
                                that.restApiDelayed.response = null;
                                that.restApiDelayed.id = id;
                                that.restApiDelayed.res = res;
                                that.restApiDelayed.prettyPrint = values.prettyPrint;
                                that.restApiDelayed.timer = setTimeout(restApiDelayedAnswer, wait);
                            }
                        } else {
                            doResponse(res, responseType, status, headers, `error: datapoint "${originId}" not found`, values.prettyPrint);
                        }
                    });
                }
                break;

            case 'toggle':
                if (!oId.length || !oId[0]) {
                    doResponse(res, responseType, status, headers, {error: 'state not given'}, values.prettyPrint);
                    break;
                }

                findState(oId[0], values.user, (err, id, originId) => {
                    if (err) {
                        doResponse(res, 'plain', 500, headers, 'error: ' + err, values.prettyPrint);
                        wait = 0;
                    } else if (id) {
                        wait = values.wait || 0;
                        if (wait) {
                            wait = parseInt(wait, 10);
                        }

                        // Read type of object
                        adapter.getForeignObject(id, {user: values.user, checked: true}, (err, obj) => {
                            if (err) {
                                status = 500;
                                if (err.indexOf('permissionError') !== -1) {
                                    status = 401;
                                }
                                doResponse(res, 'plain', status, headers, 'error: ' + err, values.prettyPrint);
                                wait = 0;
                            } else {
                                // Read actual value
                                adapter.getForeignState(id, {user: values.user, checked: true}, (err, state) => {
                                    if (err) {
                                        status = 500;
                                        if (err.indexOf('permissionError') !== -1) {
                                            status = 401;
                                        }
                                        doResponse(res, 'plain', status, headers, 'error: ' + err, values.prettyPrint);
                                        wait = 0;
                                    } else if (state) {
                                        if (obj && obj.common && obj.common.type) {
                                            if (obj.common.type === 'bool' || obj.common.type === 'boolean') {
                                                if (state.val === 'true') {
                                                    state.val = true;
                                                } else if (state.val === 'false') {
                                                    state.val = false;
                                                }
                                                state.val = !state.val;
                                            } else if (obj.common.type === 'number') {
                                                state.val = parseFloat(state.val);
                                                if (obj.common.max !== undefined) {
                                                    if (obj.common.min === undefined) obj.common.min = 0;
                                                    if (state.val > obj.common.max) {
                                                        state.val = obj.common.max;
                                                    }
                                                    if (state.val < obj.common.min) {
                                                        state.val = obj.common.min;
                                                    }
                                                    // Invert
                                                    state.val = obj.common.max + obj.common.min - state.val;
                                                } else {
                                                    // default number is from 0 to 100
                                                    if (state.val > 100) {
                                                        state.val = 100;
                                                    }
                                                    if (state.val < 0) {
                                                        state.val = 0;
                                                    }
                                                    state.val = 100 - state.val;
                                                }
                                            } else {
                                                if (state.val === 'true' || state.val === true) {
                                                    state.val = false;
                                                } else if (state.val === 'false' || state.val === false) {
                                                    state.val = true;
                                                } else if (parseInt(state.val, 10) == state.val) {
                                                    state.val = parseInt(state.val, 10) ? 0 : 1;
                                                } else {
                                                    doResponse(res, responseType, status, headers, {error: 'state is neither number nor boolean'}, values.prettyPrint);
                                                    return;
                                                }
                                            }
                                        } else {
                                            if (state.val === 'true') {
                                                state.val = true;
                                            } else if (state.val === 'false') {
                                                state.val = false;
                                            } else if (!isNaN(state.val)) {
                                                state.val = parseFloat(state.val);
                                            }

                                            if (state.val === true) {
                                                state.val = 1;
                                            }
                                            if (state.val === false) {
                                                state.val = 0;
                                            }
                                            state.val = 1 - parseInt(state.val, 10);
                                        }

                                        if (wait) adapter.subscribeForeignStates(id);

                                        adapter.setForeignState(id, state.val, false, {
                                            user: values.user,
                                            limitToOwnerRights: that.adapter.config.onlyAllowWhenUserIsOwner
                                        }, err => {
                                            if (err) {
                                                status = 500;
                                                if (err.indexOf('permissionError') !== -1) {
                                                    status = 401;
                                                }
                                                doResponse(res, 'plain', status, headers, 'error: ' + err, values.prettyPrint);
                                                wait = 0;
                                            } else if (!wait) {
                                                status = 200;
                                                doResponse(res, responseType, status, headers, {
                                                    id: id,
                                                    value: state.val,
                                                    val: state.val
                                                }, values.prettyPrint);
                                            }
                                        });

                                        if (wait) {
                                            that.restApiDelayed.responseType = responseType;
                                            that.restApiDelayed.response = null;
                                            that.restApiDelayed.id = id;
                                            that.restApiDelayed.res = res;
                                            that.restApiDelayed.prettyPrint = values.prettyPrint;
                                            that.restApiDelayed.timer = setTimeout(restApiDelayedAnswer, wait);
                                        }
                                    } else {
                                        doResponse(res, responseType, status, headers, {error: 'object has no state'}, values.prettyPrint);
                                    }
                                });
                            }
                        });
                    } else {
                        doResponse(res, responseType, status, headers, {error: `error: datapoint "${originId}" not found`}, values.prettyPrint);
                    }
                });

                break;

            // /setBulk?BidCos-RF.FEQ1234567:1.LEVEL=0.7&Licht-Küche/LEVEL=0.7&Anwesenheit=0&950=1
            case 'setBulk':
                let cnt = 0;
                response = [];
                adapter.log.debug('Values: ' + JSON.stringify(values));
                for (const _id in values) {
                    if (_id === 'prettyPrint' || _id === 'user' || _id === 'pass') continue;
                    cnt++;
                    findState(_id, values.user, (err, id, originId) => {
                        // id is "name", originId is the ioBroker-ID of the datapoint
                        if (err) {
                            adapter.log.debug('Error on ID lookup: ' + err);
                            status = 500;
                            if (err.indexOf('permissionError') !== -1) {
                                status = 401;
                            }
                            doResponse(res, 'plain', status, headers, 'error: ' + err, values.prettyPrint);
                            cnt = 0;
                        } else if (!id) {
                            response.push({error: `error: datapoint "${originId}" not found`});
                            if (!--cnt) doResponse(res, responseType, status, headers, response, values.prettyPrint);
                        } else {
                            const usedId = (values[originId] ? originId : id);
                            that.adapter.log.debug('GET-' + command + ' for id=' + id + ', oid=' + originId + 'used=' + usedId + ', value=' + values[usedId]);
                            if (values[usedId] === 'true') {
                                values[usedId] = true;
                            } else if (values[usedId] === 'false') {
                                values[usedId] = false;
                            } else if (!isNaN(values[usedId]) && values[usedId] == parseFloat(values[usedId])) {
                                values[usedId] = parseFloat(values[usedId]);
                            }

                            adapter.setForeignState(id, values[usedId], false, {
                                user: values.user,
                                limitToOwnerRights: that.adapter.config.onlyAllowWhenUserIsOwner
                            }, (err, id) => {
                                if (err) {
                                    status = 500;
                                    if (err.indexOf('permissionError') !== -1) {
                                        status = 401;
                                    }
                                    doResponse(res, 'plain', status, headers, 'error: ' + err, values.prettyPrint);
                                    cnt = 0;
                                } else {
                                    adapter.log.debug('Add to Response-Get: ' + JSON.stringify({
                                        id: id,
                                        val: values[usedId],
                                        value: values[usedId]
                                    }));
                                    response.push({id: id, val: values[usedId], value: values[usedId]});
                                    if (!--cnt) {
                                        status = 200;
                                        doResponse(res, responseType, status, headers, response, values.prettyPrint);
                                    }
                                }
                            });
                        }
                    });
                }
                if (!cnt) doResponse(res, responseType, status, headers, response, values.prettyPrint);
                break;

            case 'getObjects':
            case 'objects':
                adapter.getForeignObjects(values.pattern || parts[2] || '*', values.type, {
                    user: values.user,
                    limitToOwnerRights: that.adapter.config.onlyAllowWhenUserIsOwner
                }, (err, list) => {
                    if (err) {
                        status = 500;
                        if (err.indexOf('permissionError') !== -1) {
                            status = 401;
                        }
                        doResponse(res, responseType, status, headers, {error: JSON.stringify(err)}, values.prettyPrint);
                    } else {
                        status = 200;
                        doResponse(res, responseType, status, headers, list, values.prettyPrint);
                    }
                });
                break;

            case 'getStates':
            case 'states':
                adapter.getForeignStates(values.pattern || parts[2] || '*', {
                    user: values.user,
                    limitToOwnerRights: that.adapter.config.onlyAllowWhenUserIsOwner
                }, (err, list) => {
                    if (err) {
                        status = 500;
                        if (err.indexOf('permissionError') !== -1) {
                            status = 401;
                        }
                        doResponse(res, responseType, status, headers, {error: JSON.stringify(err)}, values.prettyPrint);
                    } else {
                        status = 200;
                        doResponse(res, responseType, status, headers, list, values.prettyPrint);
                    }
                });
                break;

            case 'search':
                if (adapter.config.dataSource && adapter.config.allDatapoints !== true) {
                    adapter.sendTo(adapter.config.dataSource, 'getEnabledDPs', {}, function (result) {
                        status = 200;
                        oId = [];
                        for (var id in result) {
                            if( result.hasOwnProperty(id) ) {
                                oId.push(id);
                            }                                 
                        }
                        doResponse(res, responseType, status, headers, oId, values.prettyPrint);
                    });
                } else {
                    that.adapter.log.debug("[SEARCH] target = " + parts[2]);

                    adapter.getForeignStates(values.pattern || parts[2] || '*', {
                        user: values.user,
                        limitToOwnerRights: that.adapter.config.onlyAllowWhenUserIsOwner
                    }, (err, list) => {
                        if (err) {
                            status = 500;
                            if (err.indexOf('permissionError') !== -1) {
                                status = 401;
                            }
                            doResponse(res, responseType, status, headers, {error: JSON.stringify(err)}, values.prettyPrint);
                        } else {
                            status = 200;
                            oId = [];
                            for (var id in list) {
                                if( list.hasOwnProperty(id) ) {
                                    oId.push(id);
                                }                                 
                            }
                            doResponse(res, responseType, status, headers, oId, values.prettyPrint);
                        }
                    });
                }
                break;

            case 'query':
                that.adapter.log.debug(JSON.stringify(parts));
                that.adapter.log.debug(JSON.stringify(values));

                let dateFrom = Date.now();
                let dateTo = Date.now();

                if (values.dateFrom) {
                    dateFrom = Date.parse(values.dateFrom);
                }
                if (values.dateTo) {
                    dateTo = Date.parse(values.dateTo);
                }

                if (!oId.length || !oId[0]) {
                    doResponse(res, responseType, status, headers, {error: 'no datapoints given'}, values.prettyPrint);
                    break;
                }
                let tcnt = oId.length;
                response = [];
                for (let b = 0; b < oId.length; b++) {
                    if (that.adapter.config.dataSource && !(values.noHistory && values.noHistory === 'true')) {
                        that.adapter.log.debug("Read data from: " + that.adapter.config.dataSource);

                        that.adapter.sendTo(that.adapter.config.dataSource, 'getHistory', {
                            id: oId[b],
                            options: {
                                start:      dateFrom,
                                end:        dateTo,
                                aggregate: 'onchange'
                            }
                        }, function (result, step, error) {
                            if (!error) status = 200;

                            that.adapter.log.debug("[QUERY] sendTo result = " + JSON.stringify(result));

                            var element = {};
                            element.target = oId[b];
                            element.datapoints = [];

                            for (var i = 0; i < result.result.length; i++) {
                                var datapoint = [result.result[i].val, result.result[i].ts];
                                element.datapoints.push(datapoint);
                            }

                            response.push(element);

                            if (!--tcnt) {
                                that.adapter.log.debug("[QUERY] response = " + JSON.stringify(response));
                                doResponse(res, responseType, status, headers, response, values.prettyPrint);
                            }
                        });
                    } else {
                        that.adapter.log.debug("Read last state");

                        getState(oId[b], values.user, (err, state, id, originId) => {
                            var element = {};
                            element.target = id;
                            element.datapoints = [];

                            if (err) {
                                tcnt = 0;
                                status = 500;
                                if (err.indexOf('permissionError') !== -1) {
                                    status = 401;
                                }
                                doResponse(res, responseType, status, headers, 'error: ' + err, values.prettyPrint);
                            } else {
                                if (id) status = 200;
                                state = state || {};

                                element.datapoints = [[state.val, state.ts]];

                                response.push(element);

                                if (!--tcnt) {
                                    that.adapter.log.debug("[QUERY] response = " + JSON.stringify(response));
                                    doResponse(res, responseType, status, headers, response, values.prettyPrint);
                                }
                            }
                        });
                    }
                }
                if (!tcnt) {
                    doResponse(res, responseType, status, headers, response, values.prettyPrint);
                }                
                break;
            
            case 'annotations':
                // iobroker does not support annontations
                that.adapter.log.debug("[ANNOTATIONS]");
                doResponse(res, responseType, 200, headers, [], values.prettyPrint);
                break;

            case 'help':
            // is default behaviour too
            default:
                status = 200;

                const obj = (command === 'help') ? {} : {error: 'command ' + command + ' unknown'};
                let request = 'http' + (that.settings.secure ? 's' : '') + '://' + req.headers.host;
                if (this.app) {
                    request += '/' + this.namespace + '/';
                }
                let auth = '';
                if (that.settings.auth) {
                    auth = 'user=UserName&pass=Password';
                }
                obj.getPlainValue = request + '/getPlainValue/stateID' + (auth ? '?' + auth : '');
                obj.get = request + '/get/stateID/?prettyPrint' + (auth ? '&' + auth : '');
                obj.getBulk = request + '/getBulk/stateID1,stateID2/?prettyPrint' + (auth ? '&' + auth : '');
                obj.set = request + '/set/stateID?value=1&prettyPrint' + (auth ? '&' + auth : '');
                obj.toggle = request + '/toggle/stateID&prettyPrint' + (auth ? '&' + auth : '');
                obj.setBulk = request + '/setBulk?stateID1=0.7&stateID2=0&prettyPrint' + (auth ? '&' + auth : '');
                obj.setValueFromBody = request + '/setValueFromBody?stateID1' + (auth ? '&' + auth : '');
                obj.objects = request + '/objects?pattern=system.adapter.admin.0*&prettyPrint' + (auth ? '&' + auth : '');
                obj.states = request + '/states?pattern=system.adapter.admin.0*&prettyPrint' + (auth ? '&' + auth : '');
                obj.search = request + '/search?pattern=system.adapter.admin.0*&prettyPrint' + (auth ? '&' + auth : '');
                obj.query = request + '/query/stateID1,stateID2/?dateFrom=2019-06-06T12:00:00.000Z&dateTo=2019-06-06T12:00:00.000Z&noHistory=false&prettyPrint' + (auth ? '&' + auth : '');

                doResponse(res, responseType, status, headers, obj, true);
                break;
        }
    };
}

module.exports = SimpleAPI;
