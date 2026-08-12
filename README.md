# T20 Hayd — Gestão de Party

Ficha de grupo (**Party Sheet**) para o sistema **Tormenta20** no FoundryVTT: reúne os personagens da party com inventário e dinheiro compartilhados, transferências entre membros e ferramentas de Mestre para recompensas, descanso e testes em grupo.

## Requisitos

- FoundryVTT **v13**
- Sistema **Tormenta20** (mínimo **1.5.0**)
- **socketlib** *(obrigatório — instalado automaticamente como dependência)*

## Instalação

Em *Configurar → Módulos Complementares → Instalar Módulo*, cole a URL do manifesto:

```
https://github.com/ahahayd/t20-hayd-management/releases/latest/download/module.json
```

## Como usar

### Criar a party (Mestre)

Crie uma pasta na barra lateral de *Atores* com os personagens do grupo e registre-a em *Configurar → Configurações → Gestão de Party → Gerenciar Parties*. Isso cria o inventário compartilhado da party.

### Party Sheet

A aba de **Membros** mostra retrato e PV/PM de cada personagem. Jogadores só veem a party a que pertencem.

### Inventário e dinheiro compartilhados

Arraste itens da ficha para o estoque da party (e de volta para qualquer membro). O Mestre pode arrastar itens de compêndio direto para o estoque, editar o dinheiro do grupo manualmente e usar o clique direito nos itens para ver, editar, alterar quantidade ou excluir.

### Transferências entre personagens

O botão de enviar dinheiro (✈) no cabeçalho da ficha, ao lado das moedas, transfere valores para outro membro ou para o estoque. Itens podem ser arrastados diretamente entre fichas da mesma party.

### Ferramentas do Mestre

Aba exclusiva na Party Sheet com três ações:

- **Distribuir dinheiro** — recompensas para os membros marcados, dividindo o total igualmente (a sobra vai ao estoque) ou entregando um valor fixo a cada um.
- **Descanso da party** — aplica o descanso do sistema a todos de uma vez, com condição (Ruim/Normal/Confortável/Luxuoso) e PV/PM extras configuráveis por personagem, prévia ao vivo da recuperação e relatório no chat com o que cada um recuperou.
- **Pedir teste de perícia** — escolha a perícia, o modo de rolagem e quais membros rolam; a janela de rolagem abre na hora no cliente de cada jogador, e personagens sem jogador online são rolados pelo Mestre.

## Detalhes adicionais

- As transferências passam pelo cliente do Mestre via socketlib, por isso o Mestre precisa estar conectado.
- Configurações em *Gestão de Party*: visibilidade para jogadores, confirmação antes de transferências, modo das mensagens de chat e integração opcional com o **t20-hayd-loja**.

## Aviso

Módulo não oficial, criado por fã, sem afiliação com a Jambô Editora ou com os autores de Tormenta20.
