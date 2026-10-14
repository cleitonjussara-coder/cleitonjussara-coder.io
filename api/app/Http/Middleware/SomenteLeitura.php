<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

/**
 * Contador só visualiza e baixa (reunião de 21/09/2026; reforçado em 14/10/2026).
 *
 * Até aqui cada controller tinha que lembrar de barrar a contabilidade; Frota,
 * Ponto, leitura de nota por IA, cache de CNPJ e consulta de QR esqueceram. Aqui
 * a regra vale para o grupo inteiro: quem é `soLeitura()` só faz GET, mais uma
 * lista curta de escritas que são do próprio perfil ou sustentam a leitura de
 * anexos. Rota nova de escrita já nasce fechada para ele.
 *
 * Nomes de rota sem o prefixo /api, como no ExigeConfirmacao.
 */
class SomenteLeitura
{
    /** Escritas que o Contador pode fazer: sair, cuidar do próprio perfil, abrir anexos. */
    private const ESCRITA_LIVRE = [
        'POST auth/logout',
        'PATCH me',
        'POST me/foto',
        'DELETE me/foto',
        'POST fotos/urls',      // é assim que ele vê os anexos das notas
        'POST notas/existem',   // conferência de lixeira/sincronização (só devolve ids)
        /* Corrigir nota incorreta (pedido do Cleiton, 14/10/2026). O NotaController
           segura o resto: só nota que já existe, sem excluir, sem trocar o dono e
           sem Faturamento. Lançar nota nova, apagar e repasse seguem fechados. */
        'PUT notas/{id}',
        'PATCH notas/{id}/tipo',
        'POST notas/{id}/foto',
        'POST notas/chave-existe',   // checagem de duplicata no formulário
        'POST notas/ler-foto',       // leitura do anexo trocado
    ];

    /** Módulos que ele não usa: nem a leitura (ponto, quilometragem, frota). */
    private const MODULOS_FECHADOS = ['veiculos', 'km', 'frota', 'ponto', 'feriados'];

    public function handle(Request $request, Closure $next): Response
    {
        $u = $request->user();
        if (! $u || ! $u->soLeitura()) {
            return $next($request);
        }

        $uri = $request->route()?->uri() ?? $request->path();
        $rota = trim((string) preg_replace('#^api/#', '', $uri), '/');
        $metodo = $request->method();

        /* o próprio nome/CPF no Perfil (o controller ainda descarta papel e regime) */
        if ($metodo === 'PATCH' && $rota === 'colaboradores/{id}' && (string) $request->route('id') === (string) $u->id) {
            return $next($request);
        }
        if (in_array($metodo.' '.$rota, self::ESCRITA_LIVRE, true)) {
            return $next($request);
        }

        if (in_array($metodo, ['GET', 'HEAD', 'OPTIONS'], true)) {
            $modulo = explode('/', $rota)[0];
            if (in_array($modulo, self::MODULOS_FECHADOS, true)) {
                return $this->negar('Contabilidade não usa este módulo.');
            }
            /* o histórico detalhado (quem apagou o quê) é do gestor */
            if ($rota === 'notas/apagadas' && $request->boolean('detalhe')) {
                return $this->negar('O histórico detalhado é só do gestor.');
            }

            return $next($request);
        }

        return $this->negar('Contabilidade só consulta e baixa arquivos.');
    }

    private function negar(string $mensagem): Response
    {
        return response()->json(['message' => $mensagem, 'somente_leitura' => true], 403);
    }
}
