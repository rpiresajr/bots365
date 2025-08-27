import asyncio
import os
import uuid
import time
from datetime import datetime
from collections import defaultdict
from telegram import Update
from telegram.ext import Application, CommandHandler, MessageHandler, filters
import requests
import json
from dotenv import load_dotenv, find_dotenv
import schedule
from pydub import AudioSegment
import io

load_dotenv(find_dotenv())

TOKEN = os.environ.get('TOKEN')
API_BASE_URL = f"{os.environ.get('API_BASE_URL')}/api"
API_LOGIN_URL = f'{API_BASE_URL}/login'
API_QUERY_URL = f'{API_BASE_URL}/ai/ask'
API_USERNAME = os.environ.get('API_USERNAME')
API_PASSWORD = os.environ.get('API_PASSWORD')
INACTIVITY_TIMEOUT = int(os.environ.get('INACTIVITY_TIMEOUT'))
ENGINE = os.environ.get('ENGINE')
CL = os.environ.get('CL')
TEMPERATURE = float(os.environ.get('TEMPERATURE'))
API_SPEECH_URL = f'{API_BASE_URL}/speech/from-audio'
API_SPEECH_TEXT_URL = f'{API_BASE_URL}/speech/from-text'
API_LANGUAGE = os.environ.get('API_LANGUAGE')

api_token = None
user_sessions = defaultdict(dict)
application = None
last_login_time = 0

if API_LANGUAGE is None:
    API_LANGUAGE='pt'

def get_or_create_session(user_id):
    current_time = time.time()
    if user_id in user_sessions:
        session = user_sessions[user_id]
        if current_time - session['last_activity'] > INACTIVITY_TIMEOUT:
            session_id = str(uuid.uuid4().hex)
            user_sessions[user_id] = {'id': session_id, 'last_activity': current_time}
        else:
            session['last_activity'] = current_time
            session_id = session['id']
    else:
        session_id = str(uuid.uuid4().hex)
        user_sessions[user_id] = {'id': session_id, 'last_activity': current_time}
    
    return session_id

async def start(update: Update, context):
    message='Olá! Em que posso ajudar?'
    if API_LANGUAGE != 'pt':
       message = 'Hello! How can I help you?'
    await update.message.reply_text(message)
    
def search_api(input, habilitaContexto, email=False, zendesk=False, session_id=None, user_name=None):
    global api_token
    
    if api_token is None:
        login_to_api()
        message = "Desculpe, não foi possível autenticar com o E.V.A. no momento."
        if API_LANGUAGE != 'pt':
            message= "Sorry, we were unable to authenticate with E.V.A. at the moment."
        if api_token is None:
            return message

    body = {
        'query': input,
        'memory': "{}",
        'searchdocs': True,
        'temperature': TEMPERATURE,
        'template': "template_contexto" if habilitaContexto else "template_internet",
        'client_id': API_USERNAME,
        'email': email,
        'zendesk': zendesk,
        'sessionid': session_id,
        'username': user_name,
        'engine': ENGINE,
        'cl': CL,
    }
    
    message = "Desculpe, ocorreu um erro ao consultar o E.V.A."
    if API_LANGUAGE != 'pt':
        message = "Sorry, an error occurred when querying the E.V.A."
    try:
        headers = {'Authorization': f'Bearer {api_token}'}
        response = requests.post(f'{API_QUERY_URL}', data=json.dumps(body), headers=headers)
        response.raise_for_status()
        reply = response.json()
    except requests.RequestException as e:
        print(str(e))
        reply = message
        
    return reply['message']

def new_session(session_id, user_name, user_id):
    session_id = get_or_create_session(user_id)
    msg1="Se apresente de maneira informal para o usuário falando sobre é um assistente virtual especializado da empresa e irá ajudá-lo"
    msg2='{"role": "system", "content": "Você é um representante comercial querendo vender um produto ou um serviço. Lembre todas as perguntas que o humano fizer"}'
    msg3="Desculpe, ocorreu um erro ao consultar a API"
    if API_LANGUAGE != 'pt':
        msg1="Introduce yourself informally to the user by talking about the company's specialized virtual assistant and will help you"
        msg2='{"role": "system", "content": "You are a sales representative wanting to sell a product or service. Remember all the questions the human asks"}'
        msg3="Sorry, an error occurred when querying the API"
    body = {
        'query':
          msg1,
        'memory':
          msg2,
        'searchdocs': False,
        'temperature': 0.9,
        'template': "template_saudacao",
        'client_id': API_USERNAME,
        'email': False,
        'zendesk': False,
        'sessionid': session_id,
        'username': user_name,
        'engine': ENGINE,
        'cl': CL,
    }
    
    try:
        headers = {'Authorization': f'Bearer {api_token}'}
        response = requests.post(f'{API_QUERY_URL}', data=json.dumps(body), headers=headers)
        response.raise_for_status()
        reply = response.json()
    except requests.RequestException as e:
        reply = {"message": f"{msg3}: {str(e)}"}
    
    return reply['message']

def login_to_api():
    global api_token, last_login_time
    try:
        response = requests.post(API_LOGIN_URL, json={
            'client_id': API_USERNAME,
            'password': API_PASSWORD
        })
        response.raise_for_status()
        api_token = response.json()['message']
        last_login_time = time.time()
        print("Login na API bem-sucedido")
    except requests.RequestException as e:
        print(f"Erro ao fazer login na API: {str(e)}")
        api_token = None

async def refresh_login(context):
    global last_login_time
    current_time = time.time()
    if current_time - last_login_time >= 3600:
        print("Refreshing API login...")
        login_to_api()

async def handle_message(update: Update, context):
    global api_token
    await refresh_login(context)
    
    message = update.message.text
    user_id = update.effective_user.id

    # Obtendo o nome e sobrenome do usuário
    first_name = update.effective_user.first_name
    last_name = update.effective_user.last_name if update.effective_user.last_name else ""

    # Montando a string com nome completo, ou apenas o nome se o sobrenome não existir
    user_name = f"TELEGRAM - {first_name} {last_name} - {user_id} - {update.effective_user.username} - {ENGINE} - Text".strip()

    if api_token is None:
        login_to_api()
        if api_token is None:
            await update.message.reply_text("Desculpe, não foi possível autenticar com a API no momento.")
            return

    await context.bot.send_chat_action(chat_id=update.effective_chat.id, action="typing")

    session_id = get_or_create_session(user_id)
    
    if 'first_message' not in user_sessions[user_id]:
        reply = new_session(session_id, user_name, user_id)
        user_sessions[user_id]['first_message'] = True
    else:
        reply = search_api(message, True, False, False, session_id, user_name)

    print(f"User ID: {user_id}, Session ID: {session_id}")
    await update.message.reply_text(reply)

async def handle_voice(update: Update, context):
    global api_token
    await refresh_login(context)
    
    user_id = update.effective_user.id
    first_name = update.effective_user.first_name
    last_name = update.effective_user.last_name if update.effective_user.last_name else ""
    user_name = f"TELEGRAM - {first_name} {last_name} - {user_id} - {update.effective_user.username} - {ENGINE} - Audio".strip()
    
    if api_token is None:
        login_to_api()
        if api_token is None:
            msg="Desculpe, não foi possível autenticar com a API no momento."
            if API_LANGUAGE != 'pt':
                msg="Sorry, we are unable to authenticate with the API at this time."
            await update.message.reply_text(msg)
            return

    await context.bot.send_chat_action(chat_id=update.effective_chat.id, action="record_audio")
    
    try:
        voice = update.message.voice
        voice_file = await context.bot.get_file(voice.file_id)
        
        ogg_bytes = await voice_file.download_as_bytearray()
        
        audio = AudioSegment.from_ogg(io.BytesIO(ogg_bytes))
        mp3_bytes = io.BytesIO()
        audio.export(mp3_bytes, format='mp3', bitrate='128k')
        mp3_bytes.seek(0)
        
        headers = {'Authorization': f'Bearer {api_token}'}
        current_time = datetime.now()
        filename_audio = f"{current_time.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4()}"
        files = {'audio': (f"audio_{filename_audio}.mp3", mp3_bytes, 'audio/mp3')}
        response = requests.post(API_SPEECH_URL, files=files, headers=headers)
        response.raise_for_status()
        
        transcribed_text = response.json()['text']
        session_id = get_or_create_session(user_id)
        
        if 'first_message' not in user_sessions[user_id]:
            reply = new_session(session_id, user_name, user_id)
            user_sessions[user_id]['first_message'] = True
        else:
            reply = search_api(transcribed_text, True, False, False, session_id, user_name)
        
        headers = {'Authorization': f'Bearer {api_token}'}
        response = requests.post(API_SPEECH_TEXT_URL, json={'text': reply}, headers=headers)
        response.raise_for_status()
        await context.bot.send_chat_action(chat_id=update.effective_chat.id, action="record_audio")
        audio_bytes = io.BytesIO(response.content)
        audio_bytes.seek(0)
        await context.bot.send_voice(
            chat_id=update.effective_chat.id,
            voice=audio_bytes,
            filename=f'response_{filename_audio}.mp3'
        )
        
    except Exception as e:
        print(f"Error processing voice message: {str(e)}")
        msg="Desculpe, ocorreu um erro ao processar sua mensagem de voz."
        if API_LANGUAGE != 'pt':
            msg="Sorry, an error occurred while processing your voice message."

        await update.message.reply_text(msg)

async def run_pending_schedules(_):
    schedule.run_pending()

async def check_expired_sessions(context):
    current_time = time.time()
    expired_sessions = []
    for user_id, session in user_sessions.items():
        if current_time - session['last_activity'] > INACTIVITY_TIMEOUT:
            expired_sessions.append(user_id)
    
    for user_id in expired_sessions:
        del user_sessions[user_id]
        await send_expired_session_message(user_id)

def main():
    global application
    login_to_api()

    application = Application.builder().token(TOKEN).build()
    application.add_handler(CommandHandler("start", start))
    application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    application.add_handler(MessageHandler(filters.VOICE, handle_voice))  # Add voice handler
    application.job_queue.run_repeating(check_expired_sessions, interval=60)
    application.job_queue.run_repeating(refresh_login, interval=60)
    application.run_polling()

async def send_expired_session_message(user_id):
    msg="Foi um prazer conversar com você! Se precisar, estou aqui. Até logo!"
    if API_LANGUAGE != 'pt':
        msg="It was a pleasure talking to you! If you need me, I'm here. See you soon!"
    try:
        await application.bot.send_message(chat_id=user_id, text=msg)
    except Exception as e:
        print(f"Erro ao enviar mensagem de sessão expirada para o usuário {user_id}: {str(e)}")

if __name__ == '__main__':
    main()
