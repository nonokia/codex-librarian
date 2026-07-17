# Edge proxy in front of the API (the *.dockerfile naming form).

FROM nginx:1.27

COPY nginx.conf /etc/nginx/nginx.conf
