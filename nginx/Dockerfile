FROM nginx:1.25

RUN rm -f /etc/nginx/conf.d/default.conf

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY logging.conf /etc/nginx/conf.d/logging.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
