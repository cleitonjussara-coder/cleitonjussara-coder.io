<?php

/*
 * Ponte do servidor MCP (Node) com o AjudaRag do servidor: lê {"pergunta","papel","k"} do stdin e escreve JSON
 * com os trechos. Usa a MESMA classe do app (api/app/Services/AjudaRag.php), então o resultado é idêntico ao do
 * assistente — sem segunda implementação de busca para divergir. Não toca no banco (cache em memória).
 */

$raiz = dirname(__DIR__, 2).'/api';
putenv('CACHE_STORE=array');
$_ENV['CACHE_STORE'] = $_SERVER['CACHE_STORE'] = 'array';

require $raiz.'/vendor/autoload.php';
$app = require $raiz.'/bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();

$in = json_decode((string) stream_get_contents(STDIN), true) ?: [];
$papel = in_array($in['papel'] ?? '', ['colaborador', 'gestor', 'admin', 'contabilidade'], true) ? $in['papel'] : 'colaborador';
$k = max(1, min(10, (int) ($in['k'] ?? 5)));

$u = new App\Models\Colaborador(['role' => $papel]);
$trechos = (new App\Services\AjudaRag)->buscar((string) ($in['pergunta'] ?? ''), $u, $k);

echo json_encode(['papel' => $papel, 'trechos' => $trechos], JSON_UNESCAPED_UNICODE);
