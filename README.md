# T20 Hayd — Gestão de Party

Ficha de grupo (**Party Sheet**) para o sistema **Tormenta20** no **FoundryVTT v13**. Reúne os personagens de uma party, com estimativas de PV/PM, inventário e dinheiro compartilhados, e transferência de itens e moedas entre os membros.

## O que faz

- **Party Sheet** com uma aba de **Membros** (retrato, PV/PM de cada personagem).
- **Inventário compartilhado** da party (um "estoque" comum): arraste itens para dentro/fora dele e entre membros.
- **Transferência de itens e dinheiro** entre personagens da mesma party.
- Botão **enviar dinheiro** no cabeçalho da ficha de personagem (ao lado das moedas), para transferir moedas a outro membro ou ao estoque.
- **Ferramentas do Mestre** (aba exclusiva na Party Sheet — v1.1.0):
  - **Distribuir dinheiro**: recompensas para os membros marcados, dividindo o total igualmente (a sobra vai ao estoque) ou entregando o valor informado a cada um.
  - **Descanso da party**: aplica o descanso do sistema a todos de uma vez, com condição (Ruim/Normal/Confortável/Luxuoso) e PV/PM extras por nível configuráveis **por personagem**, prévia ao vivo do quanto cada um vai recuperar e relatório no chat com a recuperação real de cada membro.
  - **Pedir teste de perícia**: escolha a perícia, o modo de rolagem (pública, privada, às cegas, própria) e quais membros rolam — a janela de rolagem abre na hora no cliente de cada jogador; personagens sem jogador online são rolados pelo Mestre.
- **Gestão do estoque pelo Mestre** (v1.1.0): edição manual do dinheiro da party, itens de compêndio arrastáveis direto para o inventário compartilhado, e clique direito nos itens do estoque para **ver, editar (ficha completa), alterar quantidade ou excluir**.
- Integração opcional com o **t20-hayd-loja**.

## Como usar

### Mestre — configurar a party

1. Crie uma **pasta de atores** (barra lateral *Atores*) e coloque dentro dela os personagens da party.
2. Em *Configurar → Configurações → Gestão de Party → **Gerenciar Parties***, registre a pasta como uma party (isso cria o inventário compartilhado).

### Todos — usar

- **Abrir a Party Sheet**: pelo botão na pasta da party (ou pela ação de abrir party sheet). Jogadores só veem a party a que pertencem.
- **Transferir item**: arraste da ficha para o estoque da party, ou solte uma linha do inventário da party sobre a ficha de um personagem.
- **Enviar dinheiro**: clique no botão de moedas (✈) no topo da ficha e escolha o destinatário e o valor.

## Configurações

Em *Configurar → Configurações → Gestão de Party*: visibilidade da party para jogadores, confirmação antes de transferências, modo das mensagens de chat e compatibilidade com o t20-hayd-loja.

## Requisitos

- FoundryVTT **v13**
- Sistema **Tormenta20** (mínimo **1.5.0**)
- **socketlib** *(obrigatório)* — as transferências passam pelo cliente do Mestre

## Instalação

Em *Configurar → Módulos Complementares → Instalar Módulo*, cole a URL do manifesto:

```
https://github.com/ahahayd/t20-hayd-management/releases/latest/download/module.json
```

O módulo **socketlib** é instalado como dependência.

## Aviso

Módulo não oficial, sem afiliação com a Jambô Editora ou com os autores de Tormenta20.
