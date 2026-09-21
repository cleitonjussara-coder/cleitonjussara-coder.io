<?php

namespace App\Http\Controllers;

use App\Models\CnpjCache;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** Cache compartilhado de CNPJ → razão social. Qualquer autenticado lê e grava. */
class CnpjController extends Controller
{
    public function show(string $cnpj): JsonResponse
    {
        $c = preg_replace('/\D/', '', $cnpj);
        $row = strlen($c) === 14 ? CnpjCache::find($c) : null;

        return response()->json($row ? ['razao_social' => $row->razao_social, 'nome_fantasia' => $row->nome_fantasia, 'cnae' => $row->cnae, 'cnae_descricao' => $row->cnae_descricao] : null);
    }

    public function upsert(Request $r, string $cnpj): JsonResponse
    {
        $c = preg_replace('/\D/', '', $cnpj);
        abort_unless(strlen($c) === 14, 422, 'CNPJ inválido');
        $d = $r->validate([
            'razao_social' => ['nullable', 'string', 'max:255'],
            'nome_fantasia' => ['nullable', 'string', 'max:255'],
            'cnae' => ['nullable', 'string', 'max:7'],
            'cnae_descricao' => ['nullable', 'string', 'max:160'],
        ]);
        $row = CnpjCache::updateOrCreate(['cnpj' => $c], $d + ['consultado_em' => now()]);

        return response()->json($row);
    }
}
