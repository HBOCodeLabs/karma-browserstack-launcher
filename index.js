var q = require('q');
var api = require('browserstack');
var BrowserStackTunnel = require('browserstacktunnel-wrapper');
var urlFlag = false;

var createBrowserStackTunnel = function(logger, config, emitter) {
    var log = logger.create('launcher.browserstack');
    var bsConfig = config.browserStack || {};

    if (bsConfig.startTunnel === false) {
        return q();
    }

    if (!bsConfig.tunnelIdentifier) {
        bsConfig.tunnelIdentifier = 'karma' + Math.random();
    }

    log.debug('Establishing the tunnel on %s:%s', 'localhost', 3000);

    var deferred = q.defer();

    var ports = [];

    ports.push(config.port);

    var hosts = [];

    hosts.push({
        name: 'localhost',
        port: 3000,
        sslFlag: 0
    });

    for (var i=0; i < ports.length; i++) {
        hosts.push({
            name: config.hostname,
            port: ports[i],
            sslFlag: 0
        });
    }

    var tunnel = new BrowserStackTunnel({
        key: process.env.BROWSER_STACK_ACCESS_KEY || bsConfig.accessKey,
        tunnelIdentifier: bsConfig.tunnelIdentifier,
        jarFile: process.env.BROWSER_STACK_TUNNEL_JAR || bsConfig.jarFile,
        hosts: hosts,
        skipCheck: true
    });

    tunnel.start(function(error) {
        if (error) {
            log.error('Cannot establish the tunnel.\n%s', error.toString());
            deferred.reject(error);
        } else {
            console.log("Tunnel established.");
            log.debug('Tunnel established.')
            deferred.resolve();
        }
    });

    emitter.on('exit', function(done) {
        log.debug('Shutting down the tunnel.');
        tunnel.stop(function(error) {
            done();
        });
    });

    return deferred.promise;
};

var createBrowserStackClient = function(/* config.browserStack */ config) {
    var env = process.env;

    // TODO(vojta): handle no username/pwd
    return api.createClient({
        username: env.BROWSER_STACK_USERNAME || config.username,
        password: env.BROWSER_STACK_ACCESS_KEY || config.accessKey
    });
};

var formatError = function(error) {
    if (error.message === 'Validation Failed') {
        return '  Validation Failed: you probably misconfigured the browser ' +
            'or given browser is not available.';
    }

    return error.toString();
};



var BrowserStackBrowser = function(id, emitter, args, logger,
                                   /* config */ config,
                                   /* browserStackTunnel */ tunnel, /* browserStackClient */ client) {
    var self = this;
    var workerId = null;
    var captured = false;
    var alreadyKilling = null;
    var log = logger.create('launcher.browserstack');
    var browserName = (args.browser || args.device) + (args.browser_version ? ' ' + args.browser_version : '') +
        ' (' + args.os + ' ' + args.os_version +  ')';
    this.id = id;
    this.name = browserName + ' on BrowserStack';

    var launcherConfig = config.browserstackLauncher.launcherConfig;
    var bsConfig = config.browserStack || {};
    var captureTimeout = config.captureTimeout || 0;
    var captureTimeoutId;
    var retryLimit = bsConfig.retryLimit || 3;

    var launchArgs = config.browserstackLauncher.launchArgs || [];

    if (urlFlag === false) {
        launchArgs.unshift({ name: "port", value: config.port });
        launchArgs.unshift({ name: "hostname", value: config.hostname });
        launchArgs.unshift({ name: "id", value: id });
        urlFlag = true;
    }

    var launchUrl = launcherConfig.url;

    //Concatenate the launch arguments with the Url that runs the specs
    var getQueryString = require("../../build_env/common/getQueryString");
    var query = getQueryString(launchArgs);
    if(query){
        launchUrl += "?" + query;
    }

    this.start = function(url) {
        console.log("Open Url "+ launchUrl);

        // TODO(vojta): handle non os/browser/version
        var settings = {
            os: args.os,
            os_version: args.os_version,
            device: args.device,
            browser: args.browser,
            tunnelIdentifier: bsConfig.tunnelIdentifier,
            // TODO(vojta): remove "version" (only for B-C)
            browser_version: args.browser_version || args.version || 'latest',
            url: launchUrl,
            'browserstack.tunnel': true,
            timeout: bsConfig.timeout || 300,
            project: bsConfig.project,
            name: bsConfig.name || 'Karma test',
            build: bsConfig.build || process.env.TRAVIS_BUILD_NUMBER || process.env.BUILD_NUMBER ||
                process.env.BUILD_TAG || process.env.CIRCLE_BUILD_NUM || null
        };

        this.url = url;

        tunnel.then(function() {
            client.createWorker(settings, function(error, worker) {
                var sessionUrlShowed = false;

                if (error) {
                    log.error('Can not start %s\n  %s', browserName, formatError(error));
                    return emitter.emit('browser_process_failure', self);
                }

                workerId = worker.id;
                alreadyKilling = null;

                var whenRunning = function() {
                    log.debug('%s job started with id %s', browserName, workerId);

                    if (captureTimeout) {
                        captureTimeoutId = setTimeout(self._onTimeout, captureTimeout);
                    }
                };

                var waitForWorkerRunning = function() {
                    client.getWorker(workerId, function(error, w) {
                        if (error) {
                            log.error('Can not get worker %s status %s\n  %s', workerId, browserName, formatError(error));
                            return emitter.emit('browser_process_failure', self);
                        }

                        // TODO(vojta): show immediately in createClient callback once this gets fixed:
                        // https://github.com/browserstack/api/issues/10
                        if (!sessionUrlShowed) {
                            log.info('%s session at %s', browserName, w.browser_url);
                            sessionUrlShowed = true;
                        }

                        if (w.status === 'running') {
                            whenRunning();
                        } else {
                            log.debug('%s job with id %s still in queue.', browserName, workerId);
                            setTimeout(waitForWorkerRunning, 1000);
                        }
                    });
                };

                if (worker.status === 'running') {
                    whenRunning();
                } else {
                    log.debug('%s job queued with id %s.', browserName, workerId);
                    setTimeout(waitForWorkerRunning, 1000);
                }

            });
        }, function() {
            emitter.emit('browser_process_failure', self);
        });
    };

    this.kill = function(done) {
        if (!alreadyKilling) {
            alreadyKilling = q.defer();

            if (workerId) {
                log.debug('Killing %s (worker %s).', browserName, workerId);
                client.terminateWorker(workerId, function() {
                    log.debug('%s (worker %s) successfully killed.', browserName, workerId);
                    workerId = null;
                    captured = false;
                    alreadyKilling.resolve();
                });
            } else {
                alreadyKilling.resolve();
            }
        }

        if (done) {
            alreadyKilling.promise.then(done);
        }
    };

    this.markCaptured = function() {
        captured = true;

        if (captureTimeoutId) {
            clearTimeout(captureTimeoutId);
            captureTimeoutId = null;
        }
    };

    this.isCaptured = function() {
        return captured;
    };

    this.toString = function() {
        return this.name;
    };

    this._onTimeout = function() {
        if (captured) {
            return;
        }

        log.warn('%s has not captured in %d ms, killing.', browserName, captureTimeout);
        self.kill(function() {
            if (retryLimit--) {
                self.start(launchUrl);
                killingDeferred = null;
            } else {
                emitter.emit('browser_process_failure', self);
            }
        });
    };
};

// PUBLISH DI MODULE
module.exports = {
    'browserStackTunnel': ['factory', createBrowserStackTunnel],
    'browserStackClient': ['factory', createBrowserStackClient],
    'launcher:BrowserStack': ['type', BrowserStackBrowser]
};