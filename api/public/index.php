<?php

use Illuminate\Foundation\Application;
use Illuminate\Http\Request;

define('LARAVEL_START', microtime(true));

/* Na Locaweb a pasta do subdomínio (public_html/api-petermann/public) é
   criada como root e não aceita gravação: o app Laravel inteiro mora FORA
   do web root, em $HOME/api-petermann. Este index.php é o único elo. Em
   desenvolvimento (php artisan serve) o app está um nível acima, como sempre. */
$app_dir = is_dir(__DIR__.'/../vendor') ? __DIR__.'/..' : dirname(__DIR__, 3).'/api-petermann';

// Determine if the application is in maintenance mode...
if (file_exists($maintenance = $app_dir.'/storage/framework/maintenance.php')) {
    require $maintenance;
}

// Register the Composer autoloader...
require $app_dir.'/vendor/autoload.php';

// Bootstrap Laravel and handle the request...
/** @var Application $app */
$app = require_once $app_dir.'/bootstrap/app.php';

$app->handleRequest(Request::capture());
