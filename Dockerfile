FROM node:8

# update apt-get
RUN apt-get update && apt-get install -y dnsutils

USER root
# Set up non root user
RUN useradd --user-group --create-home --shell /bin/false ows

# Setup environment variables
ENV NODE_ENV=production
ENV PKG_NAME=ltcnode
ENV APP_NAME=litecoin-services
ENV HOME_PATH=/home/ows
ENV BITCOIN_DATA=/data

ENV PKG_DIR=$HOME_PATH/$PKG_NAME
ENV APP_DIR=$HOME_PATH/$APP_NAME

# Set up folder and add install files
RUN mkdir -p $PKG_DIR && mkdir -p $BITCOIN_DATA
COPY package.json $PKG_DIR
WORKDIR $PKG_DIR

RUN chown -R ows:ows $HOME_PATH && chgrp ows /usr/local/lib/node_modules && chgrp ows /usr/local/bin

USER ows
RUN npm install -g @owstack/ltc-node@0.1.1

WORKDIR $HOME_PATH
RUN $PKG_NAME create -d $BITCOIN_DATA $APP_NAME

WORKDIR $APP_DIR
RUN $PKG_NAME install @owstack/ltc-explorer-api@0.0.5
RUN $PKG_NAME install @owstack/ltc-wallet-service@0.0.7
RUN $PKG_NAME install @owstack/ows-explorer@0.0.4

USER root
CMD ["ltcnode","start"]
