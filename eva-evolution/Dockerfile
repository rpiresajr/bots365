FROM node:18

# Diretório de trabalho
WORKDIR /app

# Copia os arquivos para dentro do container
COPY . .

# Instala as dependências localmente no projeto
RUN npm install

# Expondo a porta configurada
EXPOSE 8898

# Inicia o webhook
CMD ["node", "server.js"]
