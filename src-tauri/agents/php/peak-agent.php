<?php
// Peak agent for PHP, loaded with auto_prepend_file from an ini file Peak points PHP_INI_SCAN_DIR
// at. Reports memory and collections and answers CPU profile and GC requests.
//
// PHP has no thread to report from and no way to run code during a blocking call. With only the
// standard build, figures can be sent at exit. The Excimer extension (`pecl install excimer`) adds
// timers and a sampling profiler, which is what makes the rest possible. Its callbacks run between
// PHP operations, so nothing reports during a long sleep() or database call.
//
// It must never throw into, or change the behaviour of, the host.

namespace PeakAgent {
    final class Agent
    {
        const TICK_SECONDS = 0.5;
        const CPU_PERIOD_SECONDS = 0.005;
        const SETUP = 'Install the Excimer extension for this: pecl install excimer';
        const NO_EXTENSION = 'Needs the Excimer extension, which has no Windows build, so PHP on Windows only reports as it ends. For this, run the program on Linux or macOS.';

        private static $sock = null;
        private static $pid = 0;
        private static $buffer = '';
        private static $timer = null;
        private static $profile = null;
        private static $gc = null;

        public static function start($addr, $token)
        {
            $sock = @stream_socket_client('tcp://' . $addr, $errno, $error, 2);
            if ($sock === false) {
                return;
            }
            self::$sock = $sock;
            self::$pid = getmypid();
            self::$gc = gc_status();
            $live = self::canRunTimers();
            self::send(['type' => 'hello', 'token' => $token, 'pid' => self::$pid, 'runtime' => 'php', 'agent' => self::describe($live)]);
            // Registered from within shutdown, this runs after the program's own functions.
            register_shutdown_function(static function () {
                register_shutdown_function([self::class, 'finish']);
            });
            if ($live) {
                stream_set_blocking($sock, false);
                self::$timer = new \ExcimerTimer();
                self::$timer->setEventType(EXCIMER_REAL);
                // The first expiry, then the repeat.
                self::$timer->setInterval(self::TICK_SECONDS);
                self::$timer->setPeriod(self::TICK_SECONDS);
                self::$timer->setCallback(static function () {
                    self::tick();
                });
                self::$timer->start();
                self::report();
            }
        }

        /** A web request's process outlives it, so a timer belongs only to a command-line run. */
        private static function canRunTimers()
        {
            return class_exists('ExcimerTimer', false) && PHP_SAPI === 'cli';
        }

        private static function gcTimed()
        {
            return isset(self::$gc['collector_time']);
        }

        public static function describe($live)
        {
            $hasExcimer = class_exists('ExcimerTimer', false);
            $why = $hasExcimer
                ? 'Only available for command-line PHP, where a timer can outlive a request.'
                : (PHP_OS_FAMILY === 'Windows' ? self::NO_EXTENSION : self::SETUP);
            $capabilities = [];
            $unavailable = [
                'lag' => "PHP runs one request from start to end, with no event loop to delay.",
                'snapshot' => 'PHP has no built-in way to list what is in memory.',
            ];
            $notes = [];
            if ($live) {
                array_push($capabilities, 'heap', 'cpu', 'forcegc');
                $notes['heap'] = "Memory PHP's allocator is using, of what it holds from the system. Updated between PHP operations, so not during a long blocking call.";
                $notes['cpu'] = self::hasCpuTimer()
                    ? 'On-CPU time sampled by Excimer. Blocking calls take no time here.'
                    : 'Wall-clock time sampled by Excimer, as this platform has no CPU timer. Blocking calls count.';
                $notes['forcegc'] = "Runs PHP's cycle collector. Other memory is freed as soon as it's unused.";
                if (self::gcTimed()) {
                    $capabilities[] = 'gc';
                    $notes['gc'] = "Runs of PHP's cycle collector. Pauses are the average for the runs in each half second.";
                    $unavailable['gcFreed'] = "PHP counts the values it collects, not their bytes. See Values collected.";
                } else {
                    $unavailable['gc'] = 'Timing collections needs PHP 8.3. Counts are shown instead.';
                }
            } else {
                $unavailable += ['heap' => $why, 'gc' => $why, 'cpu' => $why, 'forcegc' => $why];
                $notes['gauges'] = 'Figures from when the program ended.';
            }
            return [
                'runtimeVersion' => PHP_VERSION,
                'agentVersion' => (string) (getenv('PEAK_AGENT_VERSION') ?: 'unknown'),
                'capabilities' => $capabilities,
                'unavailable' => $unavailable,
                'notes' => $notes,
            ];
        }

        /** Excimer only defines its CPU timer where the platform has one, which macOS doesn't. */
        private static function hasCpuTimer()
        {
            return defined('EXCIMER_CPU') && (PHP_OS_FAMILY === 'Linux' || PHP_OS_FAMILY === 'BSD');
        }

        private static function cpuEvent()
        {
            return self::hasCpuTimer() ? constant('EXCIMER_CPU') : EXCIMER_REAL;
        }

        private static function send($message)
        {
            if (self::$sock === null || getmypid() !== self::$pid) {
                return;
            }
            $data = json_encode($message, JSON_PARTIAL_OUTPUT_ON_ERROR | JSON_INVALID_UTF8_SUBSTITUTE) . "\n";
            // Only ever waits for a large reply, and not for long if the app stops reading.
            $deadline = microtime(true) + 5;
            while ($data !== '') {
                $written = @fwrite(self::$sock, $data);
                if ($written === false || microtime(true) > $deadline) {
                    return;
                }
                $data = substr($data, $written);
                if ($written === 0) {
                    $read = $except = null;
                    $write = [self::$sock];
                    @stream_select($read, $write, $except, 0, 50000);
                }
            }
        }

        private static function gauges()
        {
            $gc = gc_status();
            self::send(['type' => 'gauges', 'values' => [
                ['name' => 'Memory now', 'value' => memory_get_usage(), 'unit' => 'bytes'],
                ['name' => 'Peak memory', 'value' => memory_get_peak_usage(), 'unit' => 'bytes'],
                ['name' => 'Collector runs', 'value' => $gc['runs'], 'unit' => 'count'],
                ['name' => 'Values collected', 'value' => $gc['collected'], 'unit' => 'count'],
            ]]);
        }

        private static function collections()
        {
            $now = gc_status();
            $runs = $now['runs'] - self::$gc['runs'];
            if ($runs > 0 && self::gcTimed()) {
                $seconds = $now['collector_time'] - self::$gc['collector_time'];
                $t = (int) (microtime(true) * 1000);
                for ($i = min($runs, 50); $i > 0; $i--) {
                    self::send(['type' => 'gc', 'kind' => 'major', 'pauseMs' => $seconds * 1000 / $runs, 'freed' => 0, 't' => $t]);
                }
            }
            self::$gc = $now;
        }

        private static function report()
        {
            self::send(['type' => 'heap', 'heapUsed' => memory_get_usage(), 'heapTotal' => memory_get_usage(true), 'external' => 0]);
            self::collections();
            self::gauges();
        }

        private static function tick()
        {
            if (self::$sock === null || getmypid() !== self::$pid) {
                return;
            }
            self::report();
            while (($chunk = @fread(self::$sock, 65536)) !== false && $chunk !== '') {
                self::$buffer .= $chunk;
            }
            if (feof(self::$sock)) {
                self::$sock = null;
                self::$timer->stop();
                return;
            }
            while (($nl = strpos(self::$buffer, "\n")) !== false) {
                $line = substr(self::$buffer, 0, $nl);
                self::$buffer = substr(self::$buffer, $nl + 1);
                $req = json_decode($line, true);
                if (is_array($req)) {
                    self::handle($req);
                }
            }
        }

        private static function reply($req, $ok, $data, $error = null)
        {
            self::send(['type' => 'reply', 'reqId' => $req['reqId'] ?? 0, 'ok' => $ok, 'data' => $data, 'error' => $error]);
        }

        private static function handle($req)
        {
            $cmd = $req['cmd'] ?? '';
            if ($cmd === 'gc') {
                gc_collect_cycles();
                self::reply($req, true, null);
            } elseif ($cmd === 'cpuprofile') {
                self::beginProfile($req);
            } elseif ($cmd === 'snapshot') {
                self::reply($req, false, null, 'PHP has no built-in way to list what is in memory.');
            } else {
                self::reply($req, false, null, 'unknown command ' . $cmd);
            }
        }

        private static function beginProfile($req)
        {
            if (self::$profile !== null) {
                self::reply($req, false, null, 'a CPU profile is already being recorded');
                return;
            }
            $profiler = new \ExcimerProfiler();
            $profiler->setPeriod(self::CPU_PERIOD_SECONDS);
            $profiler->setEventType(self::cpuEvent());
            $stop = new \ExcimerTimer();
            $stop->setEventType(EXCIMER_REAL);
            $stop->setInterval(max(1, (int) ($req['ms'] ?? 1000)) / 1000);
            $stop->setCallback(static function () {
                self::endProfile();
            });
            self::$profile = ['req' => $req, 'profiler' => $profiler, 'stop' => $stop, 'began' => microtime(true)];
            $profiler->start();
            $stop->start();
        }

        private static function endProfile()
        {
            $p = self::$profile;
            self::$profile = null;
            if ($p === null) {
                return;
            }
            $p['profiler']->stop();
            $took = (microtime(true) - $p['began']) * 1000;
            $sampling = self::hasCpuTimer() ? 'excimer-cpu' : 'excimer-wall';
            $root = self::tree($p['profiler']->getLog(), self::CPU_PERIOD_SECONDS * 1000);
            self::reply($p['req'], true, ['durationMs' => $took, 'sampling' => $sampling, 'root' => $root]);
        }

        /** A call tree from Excimer's log, whose stacks run innermost first. */
        public static function tree($log, $msPerEvent)
        {
            $root = ['name' => '(root)', 'self' => 0, 'children' => []];
            foreach ($log as $entry) {
                $node = &$root;
                $frames = array_reverse($entry->getTrace());
                foreach ($frames as $frame) {
                    if (($frame['file'] ?? '') === __FILE__) {
                        continue;
                    }
                    $name = isset($frame['function'])
                        ? (isset($frame['class']) ? $frame['class'] . '::' : '') . $frame['function']
                        : (isset($frame['closure_line']) ? '{closure}' : '(main)');
                    $file = isset($frame['file']) ? basename($frame['file']) . ':' . ($frame['line'] ?? 0) : null;
                    // One function is one frame as it runs, whichever line a sample landed on.
                    $key = $name . "\0" . ($frame['file'] ?? '');
                    if (!isset($node['children'][$key])) {
                        $node['children'][$key] = ['name' => $name, 'file' => $file, 'self' => 0, 'children' => []];
                    }
                    $node = &$node['children'][$key];
                }
                $node['self'] += $entry->getEventCount() * $msPerEvent;
                unset($node);
            }
            return self::lists($root);
        }

        private static function lists($node)
        {
            $node['children'] = array_map([self::class, 'lists'], array_values($node['children']));
            if (!isset($node['file'])) {
                unset($node['file']);
            }
            return $node;
        }

        public static function finish()
        {
            if (self::$timer !== null) {
                self::$timer->stop();
            }
            if (self::$sock === null) {
                return;
            }
            if (self::$timer !== null) {
                self::report();
            } else {
                self::gauges();
            }
            @fclose(self::$sock);
            self::$sock = null;
        }

        /**
         * Peak's ini file sets auto_prepend_file, which replaces anything the user had set. Finds
         * theirs in PHP's other ini files, to run it as it would have been.
         */
        public static function userPrepend()
        {
            $files = array_filter(array_map('trim', explode(',', (string) php_ini_scanned_files())));
            array_unshift($files, (string) php_ini_loaded_file());
            $found = null;
            foreach ($files as $file) {
                if ($file === '' || basename($file) === 'peak.ini') {
                    continue;
                }
                $ini = @parse_ini_file($file, false, INI_SCANNER_RAW);
                if (is_array($ini) && !empty($ini['auto_prepend_file'])) {
                    $found = trim($ini['auto_prepend_file'], "\"' ");
                }
            }
            return $found;
        }
    }
}

namespace {
    (static function () {
        $addr = getenv('PEAK_AGENT_ADDR');
        $token = getenv('PEAK_AGENT_TOKEN');
        if ($addr && $token) {
            try {
                \PeakAgent\Agent::start($addr, $token);
            } catch (\Throwable $e) {
                // Profiling must never be why a program fails.
            }
        }
    })();
    (static function () {
        $user = \PeakAgent\Agent::userPrepend();
        if ($user !== null && $user !== __FILE__) {
            require_once $user;
        }
    })();
}
