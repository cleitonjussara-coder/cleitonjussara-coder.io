<?php

/* Só as regras que a API usa. O app valida antes; isto é a rede de
   segurança, então basta ser legível no toast. */
return [
    'required' => 'O campo :attribute é obrigatório.',
    'email' => 'Informe um e-mail válido.',
    'unique' => 'Este :attribute já está cadastrado.',
    'exists' => 'O :attribute informado não existe.',
    'min' => [
        'numeric' => 'O campo :attribute deve ser no mínimo :min.',
        'string' => 'O campo :attribute deve ter pelo menos :min caracteres.',
    ],
    'max' => [
        'numeric' => 'O campo :attribute deve ser no máximo :max.',
        'string' => 'O campo :attribute deve ter no máximo :max caracteres.',
        'file' => 'O arquivo deve ter no máximo :max KB.',
        'array' => 'O campo :attribute deve ter no máximo :max itens.',
    ],
    'size' => [
        'string' => 'O campo :attribute deve ter :size caracteres.',
    ],
    'between' => [
        'numeric' => 'O campo :attribute deve estar entre :min e :max.',
    ],
    'in' => 'O valor de :attribute não é válido.',
    'numeric' => 'O campo :attribute deve ser um número.',
    'integer' => 'O campo :attribute deve ser um número inteiro.',
    'string' => 'O campo :attribute deve ser um texto.',
    'boolean' => 'O campo :attribute deve ser verdadeiro ou falso.',
    'array' => 'O campo :attribute deve ser uma lista.',
    'date' => 'O campo :attribute deve ser uma data válida.',
    'date_format' => 'O campo :attribute deve estar no formato :format.',
    'file' => 'O campo :attribute deve ser um arquivo.',

    'attributes' => [
        'email' => 'e-mail',
        'password' => 'senha',
        'nome' => 'nome',
        'valor' => 'valor',
        'data' => 'data',
        'mes' => 'mês',
        'ano' => 'ano',
        'tipo' => 'tipo',
        'subtipo' => 'categoria',
        'cnpj' => 'CNPJ',
        'chave_nfce' => 'chave da NFC-e',
        'chave' => 'chave da NFC-e',
        'file' => 'anexo',
        'token' => 'link',
        'role' => 'cargo',
    ],
];
