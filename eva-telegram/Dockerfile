FROM python:3.8.19-slim-bullseye
USER root
RUN apt-get update -y
RUN pip install wheel
RUN apt-get install -y libcairo2 libcairo2-dev
RUN apt-get install -y libgirepository1.0-dev
RUN apt-get install -y build-essential libffi-dev libssl-dev
RUN apt-get install -y libc6-dev
WORKDIR /app
#COPY ./requirements.txt /app/requirements.txt
#RUN pip install -r requirements.txt

RUN pip install --upgrade pip
RUN pip install telegram
RUN pip install python-telegram-bot
RUN pip install requests
RUN pip install python-dotenv
RUN pip install schedule
RUN pip install "python-telegram-bot[job-queue]"
RUN pip install pydub
RUN apt install ffmpeg -y

COPY . /app
#CMD ["tail","-f","/dev/null"]
CMD ["python3","main.py"]

