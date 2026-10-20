<?php
/**
 * Plugin Name: SterraCode installer downloads
 * Description: Serves a fixed set of public files at /code-install/ without changing the active theme.
 * Version: 1.0.0
 */
if (!defined('ABSPATH')) {
    exit;
}

$sterracodeInstallerPath = parse_url(isset($_SERVER['REQUEST_URI']) ? $_SERVER['REQUEST_URI'] : '', PHP_URL_PATH);
if (!is_string($sterracodeInstallerPath) || ($sterracodeInstallerPath !== '/code-install' && strpos($sterracodeInstallerPath, '/code-install/') !== 0)) {
    return;
}
if (!defined('DONOTCACHEPAGE')) {
    define('DONOTCACHEPAGE', true);
}

add_action('parse_request', static function () use ($sterracodeInstallerPath) {
    $method = isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET';
    if (!in_array($method, array('GET', 'HEAD'), true)) {
        status_header(405);
        header('Allow: GET, HEAD');
        header('Content-Type: text/plain; charset=utf-8');
        echo "Method not allowed.\n";
        exit;
    }
    if ($sterracodeInstallerPath === '/code-install') {
        header('Location: /code-install/', true, 302);
        exit;
    }
    $name = substr($sterracodeInstallerPath, strlen('/code-install/'));
    if ($name === '') {
        $name = 'index.html';
    }
    $files = array(
        'index.html' => 'text/html',
        'style.css' => 'text/css',
        'install.sh' => 'text/plain',
        'install.ps1' => 'text/plain',
    );
    $file = WP_CONTENT_DIR . '/code-install/' . $name;
    if (!isset($files[$name]) || !is_file($file) || !is_readable($file) || is_link($file)) {
        status_header(404);
        header('Content-Type: text/plain; charset=utf-8');
        echo "Installer file not found.\n";
        exit;
    }
    while (ob_get_level() > 0) {
        if (!ob_end_clean()) {
            break;
        }
    }
    status_header(200);
    header('Content-Type: ' . $files[$name] . '; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: no-referrer');
    header('Cache-Control: no-store, max-age=0');
    header("Content-Security-Policy: default-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if ($method !== 'HEAD') {
        readfile($file);
    }
    exit;
}, 0);
